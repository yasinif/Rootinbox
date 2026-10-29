#!/usr/bin/env bash
set -uo pipefail

# tests/integration/relocation/run.sh: Relocation Test Harness Runner (A3)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"

export NODE_PATH="${ROOT_DIR}/web/node_modules"
cd "$ROOT_DIR/web"
npx playwright test --config="../tests/integration/relocation/playwright.config.ts" "$@"
