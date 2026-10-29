# RootInbox

RootInbox is a self-hosted, lightweight, modern private messaging platform and progressive web application (PWA) built with Go and React/TypeScript. It provides private communication, media sharing, and WebRTC audio/video calls designed to run reliably on resource-constrained virtual private servers (VPS) or cloud platforms like Railway.

---

## ⚠️ Security Architecture & Honest Threat Model

RootInbox is actively evolving toward a complete Zero-Knowledge End-to-End Encrypted (E2EE) architecture. Users and administrators must understand the **current threat model**:

1. **Current State (Pre-E2EE Stage 1b)**:
   - **Transport Security**: All traffic is encrypted in transit using standard TLS 1.3 / HTTPS and secure WebSockets (`wss://`).
   - **At-Rest Encryption**: Message data stored in SQLite is encrypted at rest using keys derived from server configuration.
   - **Server Visibility**: **The server currently has technical visibility into plaintext message payloads and metadata** while processing and dispatching messages. A compromised server or malicious host administrator can theoretically read conversation contents prior to the completion of E2EE Stage 1b.
2. **Planned Target State (Post-E2EE Stage 1b)**:
   - True Zero-Knowledge End-to-End Encryption where keys are generated strictly on client devices using WebCrypto and libsodium.
   - The server acts solely as a blind, untrusted ciphertext relay and blind notification dispatcher.

---

## Key Features

- **Lightweight Architecture**: Single compiled Go binary + static frontend assets. Requires < 30 MB RSS memory at runtime.
- **Zero-Config Deployment**: Automatically generates cryptographic secrets, detects platform environment (Railway, Docker, Bare VPS), and provisions the admin API key on first boot.
- **Modern Web PWA**: Installable on iOS, Android, and Desktop browsers. Offline caching, responsive layout, message search, and media attachment support.
- **Peer-to-Peer Calling**: Integrated WebRTC voice and video calls with built-in TURN/STUN relay server.
- **Push Notifications**: Standard Web Push (VAPID) support without third-party push aggregators.
- **Database**: Embedded SQLite with WAL mode — zero external database dependencies.

---

## Quick Start (Zero-Config)

### 1. Docker
```bash
docker run -d \
  -p 8080:8080 \
  -v rootinbox_data:/data \
  --name rootinbox \
  ghcr.io/yasinif/rootinbox:latest
```
Check the server startup logs to retrieve your initial one-time Admin API Key:
```bash
docker logs rootinbox
```

### 2. Standalone Binary
```bash
# Build
go build -o rootinbox ./cmd/rootinbox

# Run
./rootinbox
```
By default, RootInbox binds safely to `127.0.0.1:8080` and stores state in `./data`.

---

## Documentation

- [Deployment Guide (English)](DEPLOYMENT.md)
- [Railway Deployment Guide (Persian)](docs/RAILWAY-fa.md)
- [Security Policy & Reporting](SECURITY.md)
- [Contribution Guidelines](CONTRIBUTING.md)
- [Architecture Decision Records](docs/adr/)

---

## License

RootInbox is free software licensed under the **GNU Affero General Public License v3.0 (AGPL-3.0)**. See [LICENSE](LICENSE) for terms.
