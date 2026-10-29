# tests/integration/relocation/run.ps1: Relocation Test Harness Runner (A3)
$rootDir = (Resolve-Path "$PSScriptRoot/../../..").Path
$env:NODE_PATH = "$rootDir/web/node_modules"
Push-Location "$rootDir/web"
try {
    npx playwright test --config="../tests/integration/relocation/playwright.config.ts" $args
    exit $LASTEXITCODE
} finally {
    $env:NODE_PATH = $null
    Pop-Location
}
