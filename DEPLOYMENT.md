# RootInbox Production Deployment Guide

## Overview

RootInbox is a self-contained, single-binary Go server with an embedded React
PWA frontend. It uses pure-Go SQLite (modernc.org/sqlite) with CGO_ENABLED=0,
requiring no external database.

## Zero-Config Deployment (Railway & Cloud Containers)

RootInbox supports zero-configuration deployment on platforms like Railway:
- **Platform Auto-Detection**: Automatically detects Railway via runtime environment variables (`RAILWAY_ENVIRONMENT`, `RAILWAY_PROJECT_ID`).
- **Origin Derivation**: Derives `APP_ORIGIN` directly from `RAILWAY_PUBLIC_DOMAIN` with HTTPS enforcement.
- **Automated Secrets Persistence**: Generates and atomically persists cryptographic secrets (`IP_HASH_SECRET`, `TURN_ACTIVE_SECRET`, and initial admin key hash) into `data/secrets.json` (`0600`).
- **Waiting-For-Domain Mode**: If deployed before clicking "Generate Domain", serves a minimal read-only status page while `/health/ready` returns `200 OK` without trusting unverified `Host` headers.
- **Trusted Reverse Proxies**: Preconfigures Railway mesh private CIDRs (`10.0.0.0/8`, `100.64.0.0/10`, `172.16.0.0/12`, etc.).
- **One-Time Admin Setup**: Logs a secure admin key on first boot (storing only SHA-256). Can be reset at any time via CLI: `./rootinbox admin reset-key`.
- For step-by-step instructions in Persian, see [docs/RAILWAY-fa.md](docs/RAILWAY-fa.md).

## Container Image

### Building

```bash
# Get current commit hash and timestamp
export BUILD_HASH=$(git rev-parse --short HEAD)
export BUILD_TIME=$(date -u +%Y-%m-%dT%H:%M:%SZ)

# Build the production image
docker build \
  --build-arg VERSION=1.0.0 \
  --build-arg BUILD_HASH=$BUILD_HASH \
  --build-arg BUILD_TIME=$BUILD_TIME \
  -t rootinbox:latest .
```

### Running

```bash
docker run -d \
  --name rootinbox \
  --read-only \
  --tmpfs /tmp:noexec,nosuid,size=64m \
  -v rootinbox-data:/data \
  -p 127.0.0.1:8080:8080 \
  -e APP_ORIGIN=https://your-domain.com \
  -e IP_HASH_SECRET="<generate-a-64+-char-random-string>" \
  -e TRUSTED_PROXIES_CIDR="<your-proxy-cidr>" \
  -e PUSH_ENABLED=false \
  -e TURN_ENABLED=false \
  -e LOG_LEVEL=info \
  -e DB_PATH=/data/db/app.db \
  -e MEDIA_PATH=/data/media \
  rootinbox:latest
```

> **IMPORTANT**: Do NOT set `INSECURE_DEV_MODE`. It defaults to `false`.
> In production, `APP_ORIGIN` MUST be `https://...`.

### Persistent Volume Layout (RFC-0012 §5)

| Path | Contents | Notes |
|---|---|---|
| `/data/db/app.db` | SQLite database | WAL mode. `-wal` and `-shm` sidecars live alongside. |
| `/data/media/` | Encrypted media chunks | Co-located with DB for backup atomicity. |

The `/data` volume MUST be backed by persistent storage (not tmpfs).

### Volume Initialization & Automated Permission Setup

The container includes a dedicated static launcher binary (`/launcher`) as its `ENTRYPOINT`.
When deployed on platforms where fresh persistent storage volumes are mounted with root ownership (such as Railway, Kubernetes, or Docker defaults):
1. `/launcher` starts initially as root.
2. It automatically ensures `/data/db` and `/data/media` directories exist with permissions `0750`.
3. It recursively sets ownership of `/data` and all contained files/folders to `nonroot:nonroot` (`UID 65532, GID 65532`).
4. It drops all root privileges via `syscall.Setgroups`, `syscall.Setgid(65532)`, and `syscall.Setuid(65532)`.
5. It replaces itself via `syscall.Exec` with `/rootinbox`.

As a result, `/rootinbox` executes exclusively as non-root (UID `65532`) in strict adherence to RFC-0012 §4.2 without requiring manual volume pre-chowning on managed cloud platforms.

For local bare host bind mounts (`-v /path/on/host:/data`), permissions will automatically be aligned to UID `65532` on boot.

### Read-Only Root Filesystem

The container runs with `--read-only`. Only `/data` is writable (via volume mount).
A small tmpfs at `/tmp` is provided for any transient OS-level needs.

## Environment Variable Reference

### Required Variables

| Variable | Description | Example |
|---|---|---|
| `APP_ORIGIN` | Canonical deployment origin. Used for WebSocket Origin validation and same-origin policy. Must be `https://` in production. | `https://chat.example.com` |
| `IP_HASH_SECRET` | Secret key (≥32 bytes) for deterministic, irreversible IP hashing. Supports `_FILE` suffix for file-based secrets. | `<random-64-char-string>` |
| `TRUSTED_PROXIES_CIDR` | Comma-separated CIDR allowlist for X-Forwarded-For trust. Required in production. Cannot be `0.0.0.0/0` or `::/0`. | `10.0.0.0/8,172.16.0.0/12` |
| `DB_PATH` | Path to SQLite database file. | `/data/db/app.db` |
| `MEDIA_PATH` | Path to encrypted media storage directory. | `/data/media` |

### Optional Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` / `SERVER_PORT` | `8080` | Application listen port. `SERVER_PORT` overrides `PORT`. |
| `SERVER_HOST` | `0.0.0.0` | Listen address. |
| `LOG_LEVEL` | `info` | slog verbosity (`debug`, `info`, `warn`, `error`). |
| `PUSH_ENABLED` | `true` | Enable Web Push notifications. Requires VAPID keys when `true`. |
| `PUSH_VAPID_ENCRYPTION_KEY` | — | Base64URL-encoded 32-byte key for VAPID private key encryption. Required when PUSH_ENABLED=true. |
| `PUSH_VAPID_SUBJECT` | — | Admin contact (`mailto:` or `https://` URL). Required when PUSH_ENABLED=true. |
| `TURN_ENABLED` | `false` | Enable embedded STUN/TURN server. See TURN section below. |
| `TURN_ACTIVE_SECRET` | — | HMAC secret (≥32 bytes) for TURN credential generation. Required when TURN_ENABLED=true. |
| `TURN_PREVIOUS_SECRET` | — | Previous TURN secret for graceful rotation. |
| `SECURITY_EVENTS_RETENTION_DAYS` | `90` | Audit log retention period. |
| `INSECURE_DEV_MODE` | `false` | **NEVER set in production.** Relaxes HTTPS and proxy requirements. |
| `ADMIN_TOKEN_HASH` | — | SHA-256 hex digest of the admin API key. |
| `ADMIN_ENABLED` | `false` | Enable admin API endpoints. |
| `ADMIN_API_KEY_HASH_ACTIVE` | — | Hex-encoded 32-byte hash of the active admin API key. Supports `_FILE` suffix. |

### Secret File Support (`_FILE` suffix)

Any secret variable that uses `loadSecret()` or `loadHexSecret()` supports
a `_FILE` suffix variant. When both `$NAME` and `$NAME_FILE` are set, startup
fails with an ambiguity error.

Supported `_FILE` variables:
- `IP_HASH_SECRET_FILE` → reads secret from file path
- `ADMIN_API_KEY_HASH_ACTIVE_FILE`
- `ADMIN_API_KEY_HASH_PREVIOUS_FILE`

Mount secret files at `/run/secrets/` (read-only):
```bash
docker run ... \
  -v /path/to/secrets:/run/secrets:ro \
  -e IP_HASH_SECRET_FILE=/run/secrets/ip_hash_secret \
  rootinbox:latest
```

## TURN/UDP Container Limitation

The embedded TURN server (pion/turn) binds UDP port 3478. Container platforms
(especially PaaS like Railway, Fly.io, Render) typically do **not** support UDP
port forwarding or have unreliable UDP networking.

**Recommendation for container deployments:**
- Set `TURN_ENABLED=false` in the container.
- Deploy a dedicated TURN server (e.g., coturn) on a VPS with direct UDP access.
- Configure clients to use the external TURN server URL.

WebSocket (WSS) and HTTPS traffic work perfectly through standard container
port mappings and PaaS reverse proxies.

## Reverse Proxy Requirements (RFC-0012 §6)

The application MUST sit behind exactly one trusted reverse proxy that:
1. Terminates TLS (TLS 1.2 minimum, 1.3 preferred).
2. Supports WebSocket Upgrade (`Connection: Upgrade` forwarding).
3. Sets idle/read timeout ≥ 60 seconds.
4. Passes response headers unmodified.
5. Does NOT rewrite the HTTP `Origin` header.
6. Strips client-supplied `X-Forwarded-For` and constructs its own.

Example Caddy configuration:
```
chat.example.com {
    reverse_proxy localhost:8080
}
```

Example nginx configuration:
```nginx
server {
    listen 443 ssl http2;
    server_name chat.example.com;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;

        # WebSocket support
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";

        # Timeout floor
        proxy_read_timeout 120s;
        proxy_send_timeout 120s;
    }
}
```

## Health Check

The application exposes `GET /health/ready` which returns HTTP 200 when:
- All migrations have been applied
- Database connections are healthy
- Configuration is validated
- Server is ready to accept traffic

Use this as the Docker health check or load balancer probe:
```bash
docker run ... \
  --health-cmd="wget -qO- http://localhost:8080/health/ready || exit 1" \
  --health-interval=30s \
  --health-timeout=5s \
  --health-retries=3 \
  rootinbox:latest
```

> Note: distroless has no shell, wget, or curl. For production health checks,
> use the Docker daemon's built-in TCP check, or an external probe.
> Alternative: use a sidecar or the orchestrator's HTTP health check feature.

## Process Supervision (RFC-0012 §10)

- **Single-Writer Constraint**: Only ONE instance may access `/data`.
  Multi-instance scaling is FORBIDDEN (SQLite single-writer).
- **Graceful Shutdown**: SIGTERM → 30-second drain deadline → force close.
- **Crash Restart Backoff**: At least 30 seconds between crash restarts
  to prevent SQLite lock race conditions.

## Backup & Restore

Refer to RFC-0012 §11 for the full backup contract. Key points:
- Use SQLite's online backup API (via `modernc.org/sqlite`)
- Never raw-copy the live `.db` file
- Both DB and media must share the same `backup_id`

## Railway Deployment

RootInbox is designed for seamless deployment on Railway using Dockerfile auto-build and Railway Persistent Volumes.

### Persistent Volume Requirement

The `/data` mount **MUST** be backed by a Railway Persistent Volume:
1. In the Railway dashboard: select your service -> **Settings** -> **Volumes** -> **Add Volume**.
2. Set **Mount Path** to `/data`.
3. This ensures `/data/db/app.db` (SQLite database) and `/data/media` (media chunks) survive redeploys and restarts.
4. The container's `/launcher` binary automatically provisions `/data/db` and `/data/media` with `0750` permissions, aligns volume ownership to non-root UID `65532` (`nonroot`), and drops privileges before running the server.

### Environment Variables

Configure the following variables in Railway (**Variables** tab):

| Variable | Value / Format | Purpose |
|---|---|---|
| `APP_ORIGIN` | `https://<your-service>.up.railway.app` | Canonical domain (HTTPS, no trailing slash). Used for WebSocket Origin validation. |
| `PORT` | Auto-injected by Railway | Application listen port (defaults to `8080`). Server binds to `0.0.0.0:${PORT}`. |
| `DB_PATH` | `/data/db/app.db` | Persistent database path on the `/data` volume. |
| `MEDIA_PATH` | `/data/media` | Persistent media chunks path on the `/data` volume. |
| `IP_HASH_SECRET` | 64+ char random string | Irreversible IP hashing salt (minimum 32 bytes). |
| `TRUSTED_PROXIES_CIDR` | `10.0.0.0/8,100.64.0.0/10,172.16.0.0/12` | CIDR allowlist for Railway's reverse proxy infrastructure. |
| `PUSH_ENABLED` | `true` | Enables Web Push notifications (or `false` to disable). |
| `PUSH_VAPID_ENCRYPTION_KEY` | 32-byte unpadded base64url string | Key used to encrypt the VAPID private key at rest in SQLite. Strict unpadded base64url (padding '=' is rejected at startup). |
| `PUSH_VAPID_SUBJECT` | `mailto:<your-real-email>` or `https://...` | RFC 8292 contact claim for web push services. |
| `LOG_LEVEL` | `info` | Structured log verbosity (`debug`, `info`, `warn`, `error`). |

### Generating the VAPID Encryption Key

The key **must be unpadded base64url** (exactly 43 characters, without '=' padding). Any key containing '=' padding will be rejected at config parsing during server startup with a clear error message. Generate a cryptographically secure 32-byte unpadded base64url string using any of these methods:

**PowerShell (Windows):**
```powershell
$bytes = New-Object byte[] 32
[Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
[Convert]::ToBase64String($bytes).Replace('+', '-').Replace('/', '_').TrimEnd('=')
```

**Bash / OpenSSL (macOS/Linux):**
```bash
openssl rand 32 | base64 | tr '+/' '-_' | tr -d '=\n'
```

**Node.js:**
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

> [!WARNING]
> **Immutability Invariant**: The `PUSH_VAPID_ENCRYPTION_KEY` **must never change once set**. Changing this key prevents decrypting the stored VAPID identity, causing startup to fail with error `[PUSH_002]`.

### Safe Rollout Order

When upgrading an existing deployment:
1. **Deploy Code First**: Let Railway build from the Dockerfile and deploy with existing variables (`PUSH_ENABLED=false`). Verify `/health/ready` returns HTTP 200.
2. **Add Push Variables**: Once the deployment is verified, set `PUSH_ENABLED=true`, `PUSH_VAPID_ENCRYPTION_KEY`, and `PUSH_VAPID_SUBJECT` in Railway Variables.
3. On restart, the automated VAPID migration transparently re-encrypts the stored zero-key identity under your configured key and enables Web Push.

### Rollback Procedure & Post-Migration Compatibility Matrix

If you encounter issues during rollout, review the verified behavior matrix after the live database has been migrated:

| Scenario | Code Version | Variables Set | Server Health (`/health/ready`) | Push Endpoints | Notes |
|---|---|---|---|---|---|
| **(i) Emergency Rollback** | New code | `PUSH_ENABLED=false` | **HTTP 200 OK** | **HTTP 404** (`PUSH_001`) | Recommended rollback path. Bypasses VAPID key loading completely; non-destructive to stored key. |
| **(ii) Binary Rollback (Active)** | Old code (`a4835b7`) | `PUSH_ENABLED=true` + `PUSH_VAPID_ENCRYPTION_KEY=<real-key>` + `PUSH_VAPID_SUBJECT` | **HTTP 200 OK** | **HTTP 200 OK** | Old build successfully decrypts migrated row using configured key. |
| **(iii) Binary Rollback (Disabled)** | Old code (`a4835b7`) | `PUSH_ENABLED=false` + `PUSH_VAPID_ENCRYPTION_KEY=<real-key>` | **HTTP 200 OK** | **HTTP 404** (`PUSH_001`) | Old build decrypts key on boot, disables push handlers. |
| **(iv) Binary Rollback (Key Removed)** | Old code (`a4835b7`) | `PUSH_ENABLED=false` + key variable REMOVED | **CRASH ON STARTUP** | N/A | **DO NOT REMOVE KEY**: Old code unconditionally initializes VAPID keys on boot; without the variable, it tries zero-key decryption against migrated ciphertext and aborts with `[PUSH_002]`. |

1. **Redeploy Previous Deployment / Disable Push**: In the Railway Dashboard under **Deployments**, you can click **Redeploy** on the prior working deployment. Alternatively, in Railway Variables, set `PUSH_ENABLED=false` and trigger a deployment.
2. **Graceful Degradation (Emergency Rollback)**: With `PUSH_ENABLED=false` on the new code, the server skips VAPID key loading and database access for push keys entirely. It will NEVER crash because of an existing migrated or unmigrated VAPID row in the database. Push endpoints return HTTP 404 (`PUSH_001 push disabled`), and web clients automatically fall back to foreground polling without error loops.
3. **Key Mismatch Recovery**: If the deployment fails to start with `[PUSH_002] vapid private key decryption failed: PUSH_VAPID_ENCRYPTION_KEY does not match stored key`, verify that the encryption key variable matches the original key used when push was first initialized. If needed, temporarily set `PUSH_ENABLED=false` to restore server availability while retrieving the correct key.
4. **Data Safety**: Disabling push never deletes or alters the stored encrypted VAPID keypair in SQLite. Rollback is completely non-destructive.

### Log Locations & Diagnostics

- **Railway Dashboard**: View logs under **Deployments** -> select active deployment -> **Deploy Logs** and **Runtime Logs**.
- **CLI**: Stream live logs with `railway logs`.
- **Diagnostic Log Codes**: RootInbox logs in structured JSON format (`slog`). Search logs for push-related diagnostic codes:
  - `PUSH_001`: Push disabled (`PUSH_ENABLED=false`) or missing configuration.
  - `PUSH_002`: VAPID private key decryption failure (mismatched `PUSH_VAPID_ENCRYPTION_KEY`).
  - `PUSH_003`: VAPID key generation or unmarshaling failure.
  - `PUSH_004`: Push subscription validation or database storage failure.
  - `PUSH_005`: Web push delivery dispatch failure (e.g., 410 Gone / expired subscriptions cleaned up).


