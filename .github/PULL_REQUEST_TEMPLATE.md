## Description
Briefly describe what this PR changes and why.

## Issue Reference
Fixes #(issue number)

## Pre-Submission Verification
Please verify each of the following locally before submitting:
- [ ] `go test ./...` passes
- [ ] `gofmt -s -w .` clean
- [ ] `go vet ./...` clean
- [ ] `cd web && npm test` passes
- [ ] `cd web && npm run build` succeeds
- [ ] `cd web && npm run lint` passes
- [ ] Git commit author uses verified noreply address (`git config user.email`)
- [ ] No secrets, private keys, or personal tokens are included
