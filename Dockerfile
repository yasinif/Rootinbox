# ============================================================
# RootInbox Production Container — RFC-0012 §4.1 Multi-Stage
# ============================================================

# ---- Stage 1: Frontend Builder ----
# Produces web/dist/ (Vite production build with Service Worker)
FROM node:22-alpine AS frontend

WORKDIR /build/web

# Copy package manifests first for layer caching
COPY web/package.json web/package-lock.json ./

# Deterministic install from lockfile
RUN npm ci --ignore-scripts && \
    node -e "require('fs').writeFileSync('node_modules/go.mod', 'module ignored\n')"

# Copy frontend source
COPY web/ ./

# Build production bundle: tsc -b && vite build
# Output: /build/web/dist/  (index.html, assets/, sw.js)
RUN npm run build


# ---- Stage 2: Go Builder ----
# Compiles the single Go binary with the frontend embedded via embed.FS
FROM golang:1.26-alpine AS builder

# Build-time arguments for version injection via ldflags
ARG VERSION=docker
ARG BUILD_HASH=unknown
ARG BUILD_TIME=unknown

WORKDIR /build

# Copy Go module manifests first for layer caching
COPY go.mod go.sum ./
RUN go mod download && go mod verify

# Copy all Go source code (includes web/embed.go)
COPY cmd/ cmd/
COPY internal/ internal/
COPY pkg/ pkg/
COPY web/embed.go web/embed.go

# *** CRITICAL: Copy the Vite dist from Stage 1 into web/dist/ ***
# The embed directive `//go:embed all:dist` in web/embed.go requires
# web/dist/ to exist with content at compile time.
COPY --from=frontend /build/web/dist/ web/dist/

# Pure-Go static build (modernc.org/sqlite, no CGO)
# RFC-0012 §4.1: CGO_ENABLED=0
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build \
    -ldflags "-s -w \
      -X main.version=${VERSION} \
      -X main.buildHash=${BUILD_HASH} \
      -X main.buildTime=${BUILD_TIME}" \
    -o /rootinbox \
    ./cmd/rootinbox

# Build lightweight launcher for permission initialization and privilege drop
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build \
    -ldflags "-s -w" \
    -o /launcher \
    ./cmd/launcher


# ---- Stage 3: Runtime ----
# Minimal, non-shell, non-root runtime image
# RFC-0012 §4.2: distroless/static, pinned by digest, non-root UID
#
# NOTE: Resolve the current digest with:
#   docker pull gcr.io/distroless/static-debian12:nonroot
#   docker inspect --format='{{index .RepoDigests 0}}' gcr.io/distroless/static-debian12:nonroot
# Then replace the tag below with the digest. Example:
#   FROM gcr.io/distroless/static-debian12@sha256:<DIGEST>
FROM gcr.io/distroless/static-debian12:nonroot

# Copy the compiled binary and launcher
COPY --from=builder /rootinbox /rootinbox
COPY --from=builder /launcher /launcher

# RFC-0012 §9: Application port (private network, behind reverse proxy)
EXPOSE 8080

# Starts as root to initialize volume directory ownership on fresh mounts,
# then drops privileges to nonroot (UID 65532, GID 65532) before execing /rootinbox
USER root

# RFC-0012 §10: Single-writer, graceful drain (SIGTERM → 30s shutdown)
ENTRYPOINT ["/launcher"]
