# Source Code Headers Policy (AGPL-3.0)

All original source code files in the RootInbox repository should include standard SPDX-compatible header annotations to clearly identify licensing and copyright.

---

## 1. Standard Header Block

### Go Files (`*.go`)
```go
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 RootInbox Authors
```

### TypeScript / JavaScript Files (`*.ts`, `*.tsx`, `*.js`, `*.mjs`)
```typescript
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 RootInbox Authors
```

### CSS Files (`*.css`)
```css
/* SPDX-License-Identifier: AGPL-3.0-only */
/* Copyright (C) 2026 RootInbox Authors */
```

### Shell / PowerShell Scripts (`*.sh`, `*.ps1`)
```bash
# SPDX-License-Identifier: AGPL-3.0-only
# Copyright (C) 2026 RootInbox Authors
```

---

## 2. Exceptions & Third-Party Files
- **Generated Files**: Files generated during build (e.g. `web/dist/*`, protobuf output, or test mocks) do not require manual header blocks.
- **Third-Party / Vendored Code**: If third-party code is included, preserve the original copyright notice and license headers verbatim; do not replace them with the RootInbox header.
- **Configuration & Documentation**: JSON (`package.json`, `tsconfig.json`), YAML (`.github/workflows/*`), and Markdown (`*.md`) files are exempt from header comments.
