# scripts/zk-audit.ps1: RootInbox Zero-Knowledge Audit Script (A2)
$ErrorActionPreference = "Stop"
$rootDir = (Resolve-Path "$PSScriptRoot/..").Path
Push-Location $rootDir
try {
    go run ./cmd/zk-audit $args
    exit $LASTEXITCODE
} finally {
    Pop-Location
}
