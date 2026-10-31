# Contributing to RootInbox

Thank you for your interest in contributing to RootInbox! RootInbox is an open-source project dedicated to private, lightweight self-hosted messaging.

---

## Code of Conduct

Maintain respectful, inclusive, and constructive communication across issues, pull requests, and discussions.

---

## Development Environment Setup

### Prerequisites
- **Go**: 1.23 or newer
- **Node.js**: 20+ with npm
- **Docker**: For running integration tests and TURN relay drills

### Initial Setup
```bash
# Clone the repository
git clone https://github.com/yasinif/Rootinbox.git
cd Rootinbox

# Install frontend dependencies
cd web
npm install
cd ..

# Verify backend builds and tests pass
go test ./...
```

---

## Workflow & Pull Requests

1. **Create an Issue First**: For non-trivial features or architecture changes, open an issue or RFC discussion first.
2. **Branching**:
   - Feature branches: `feat/<feature-name>`
   - Bug fix branches: `fix/<bug-description>`
   - CI / tooling: `ci/<tool-description>`
3. **Commit Identity**:
   - Ensure your local git identity uses your verified GitHub noreply email address:
     ```bash
     git config user.name "Your Name"
     git config user.email "your-user-id+username@users.noreply.github.com"
     ```
4. **Quality Gates & Pre-Submission Checklist**:
   - Backend tests: `go test -race ./...` (or standard `go test ./...`)
   - Backend formatting: `gofmt -s -w .`
   - Static analysis: `go vet ./...`
   - Frontend tests: `cd web && npm test`
   - Frontend build & lint: `cd web && npm run build && npm run lint`
   - End-to-End tests: `cd web && npx playwright test`
5. **Licensing**:
   - All contributions must be compatible with the GNU Affero General Public License v3.0 (AGPL-3.0).

---

## Support

If you need help configuring or troubleshooting RootInbox:
- **Discussions**: Use [GitHub Discussions](https://github.com/yasinif/Rootinbox/discussions) for architecture questions, community help, and deployment sharing.
- **Issue Tracker**: Use [GitHub Issues](https://github.com/yasinif/Rootinbox/issues) exclusively for verified bugs and reproducible problems.
- **Security Inquiries**: For security vulnerabilities, do not open public issues. Follow the guidelines in [SECURITY.md](SECURITY.md).

