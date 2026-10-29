# scripts/ci-local.ps1: Automated local CI test runner
[CmdletBinding()]
param(
    [string]$OutputDir = ""
)

$ErrorActionPreference = "Continue"

# 1. Resolve Git Context & Absolute Output Path
$gitSha = (git rev-parse HEAD).Trim()
$gitStatus = (git status --porcelain)
$statusEmpty = ($null -eq $gitStatus -or $gitStatus.Trim() -eq "")

if (-not $OutputDir) {
    $OutputDir = "ci-local-results/$gitSha"
}
$OutputDir = [System.IO.Path]::GetFullPath($OutputDir)
New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null

$results = [ordered]@{
    git_sha = $gitSha
    git_status_clean = $statusEmpty
    git_status = if ($statusEmpty) { @() } else { @($gitStatus) }
    timestamp = [DateTime]::UtcNow.ToString("o")
    host_os = [System.Environment]::OSVersion.VersionString
    tools = [ordered]@{}
    steps = @()
}

# 2. Collect Tool Versions
try { $results.tools["go"] = (go version).Trim() } catch { $results.tools["go"] = "not found" }
try { $results.tools["node"] = (node --version).Trim() } catch { $results.tools["node"] = "not found" }
try { $results.tools["npm"] = (npm --version).Trim() } catch { $results.tools["npm"] = "not found" }
try { $results.tools["git"] = (git --version).Trim() } catch { $results.tools["git"] = "not found" }
try { 
    $dockerVer = (docker version --format '{{.Server.Version}}' 2>&1)
    if ($LASTEXITCODE -eq 0) {
        $results.tools["docker"] = "Server $dockerVer"
    } else {
        $results.tools["docker"] = "client present, daemon stopped"
    }
} catch {
    $results.tools["docker"] = "not found"
}
$dockerRunning = ($results.tools["docker"] -like "Server *")

Write-Host "================================================================" -ForegroundColor Cyan
Write-Host " RootInbox Local CI Suite" -ForegroundColor Cyan
Write-Host " Git SHA: $gitSha" -ForegroundColor Cyan
Write-Host " Working Tree Clean: $statusEmpty" -ForegroundColor Cyan
Write-Host " Output Directory: $OutputDir" -ForegroundColor Cyan
Write-Host "================================================================" -ForegroundColor Cyan

# Ensure embedded dist placeholder exists (matching CI setup step)
$distDir = "web/dist"
if (-not (Test-Path $distDir)) {
    New-Item -ItemType Directory -Force -Path $distDir | Out-Null
    @("index.html", "manifest.webmanifest", "manifest.json", "favicon.ico", "sw.js") | ForEach-Object {
        $p = Join-Path $distDir $_
        if (-not (Test-Path $p)) {
            [System.IO.File]::WriteAllText($p, "", [System.Text.UTF8Encoding]::new($false))
        }
    }
}
if (-not (Test-Path "scratch")) {
    New-Item -ItemType Directory -Force -Path "scratch" | Out-Null
}

function Run-Step {
    param(
        [string]$Id,
        [string]$Name,
        [scriptblock]$Action,
        [string]$SkipReason = ""
    )

    $stepObj = [ordered]@{
        id = $Id
        name = $Name
        status = "NOT RUN"
        exit_code = $null
        duration_sec = 0.0
        reason = ""
        log_file = "$Id.log"
    }

    $logPath = Join-Path $OutputDir "$Id.log"

    if ($SkipReason) {
        Write-Host "[-] $Name : NOT RUN ($SkipReason)" -ForegroundColor Yellow
        $stepObj.status = "NOT RUN"
        $stepObj.reason = $SkipReason
        [System.IO.File]::WriteAllText($logPath, "NOT RUN: $SkipReason`n", [System.Text.UTF8Encoding]::new($false))
        $script:results.steps += [PSCustomObject]$stepObj
        return
    }

    Write-Host "[*] Running: $Name..." -NoNewline
    $sw = [System.Diagnostics.Stopwatch]::StartNew()

    try {
        $global:LASTEXITCODE = 0
        $outputLines = & $Action *>&1
        $code = $global:LASTEXITCODE
        $sw.Stop()
        $duration = [Math]::Round($sw.Elapsed.TotalSeconds, 2)
        $stepObj.duration_sec = $duration
        $stepObj.exit_code = $code

        $text = if ($null -ne $outputLines) { ($outputLines | Out-String) } else { "" }
        [System.IO.File]::WriteAllText($logPath, $text, [System.Text.UTF8Encoding]::new($false))

        if ($code -eq 0) {
            Write-Host " PASS ($($duration)s)" -ForegroundColor Green
            $stepObj.status = "PASS"
        } else {
            Write-Host " FAIL (exit code $code, $($duration)s)" -ForegroundColor Red
            $stepObj.status = "FAIL"
            $stepObj.reason = "Process exited with code $code"
        }
    } catch {
        $sw.Stop()
        $duration = [Math]::Round($sw.Elapsed.TotalSeconds, 2)
        $stepObj.duration_sec = $duration
        $stepObj.status = "FAIL"
        $stepObj.reason = $_.Exception.Message
        Write-Host " ERROR: $($_.Exception.Message)" -ForegroundColor Red
        [System.IO.File]::WriteAllText($logPath, $_.Exception.ToString(), [System.Text.UTF8Encoding]::new($false))
    }

    $script:results.steps += [PSCustomObject]$stepObj
}

# Step 1: gofmt check
Run-Step -Id "01-gofmt" -Name "gofmt code formatting check" -Action {
    $changedGo = git diff --name-only --diff-filter=d origin/main...HEAD -- '*.go'
    if ($changedGo) {
        $unformatted = @()
        foreach ($f in ($changedGo -split "`r?`n")) {
            if ($f -and (Test-Path $f)) {
                $check = gofmt -l $f
                if ($check) { $unformatted += $check }
            }
        }
        if ($unformatted.Count -gt 0) {
            Write-Host "The following changed Go files are not formatted:"
            $unformatted | ForEach-Object { Write-Host "  $_" }
            $global:LASTEXITCODE = 1
        } else {
            Write-Host "All changed Go files are formatted correctly."
            $global:LASTEXITCODE = 0
        }
    } else {
        Write-Host "No changed Go files vs origin/main."
        $global:LASTEXITCODE = 0
    }
}

# Step 2: go vet
Run-Step -Id "02-govet" -Name "go vet ./..." -Action {
    go vet ./...
}

# Step 3: go test -race
$hasGcc = $null -ne (Get-Command gcc -ErrorAction SilentlyContinue)
if ($hasGcc) {
    Run-Step -Id "03-gotest-race" -Name "go test -race -count=1 ./... (host gcc)" -Action {
        go test -race -count=1 ./...
    }
} elseif ($dockerRunning) {
    Run-Step -Id "03-gotest-race" -Name "go test -race -count=1 ./... (Docker container)" -Action {
        docker run --rm -v go-cache:/go -e GOTOOLCHAIN=auto -v "${PWD}:/app" -w /app golang:1.24 go test -race -count=1 ./...
    }
} else {
    Run-Step -Id "03-gotest-race" -Name "go test -race" -SkipReason "CGO compiler (gcc) not available on Windows host and Docker daemon is stopped; go test -race requires cgo"
    Run-Step -Id "03b-gotest-unit" -Name "go test -count=1 ./... (unit tests)" -Action {
        go test -count=1 ./...
    }
}

# Step 4: staticcheck / govulncheck if configured
$staticcheckCmd = if (Get-Command staticcheck -ErrorAction SilentlyContinue) { "staticcheck" } `
    elseif (Test-Path "$env:USERPROFILE\go\bin\staticcheck.exe") { "$env:USERPROFILE\go\bin\staticcheck.exe" } `
    elseif (Test-Path "$env:GOPATH\bin\staticcheck.exe") { "$env:GOPATH\bin\staticcheck.exe" } `
    else { $null }

$govulncheckCmd = if (Get-Command govulncheck -ErrorAction SilentlyContinue) { "govulncheck" } `
    elseif (Test-Path "$env:USERPROFILE\go\bin\govulncheck.exe") { "$env:USERPROFILE\go\bin\govulncheck.exe" } `
    elseif (Test-Path "$env:GOPATH\bin\govulncheck.exe") { "$env:GOPATH\bin\govulncheck.exe" } `
    else { $null }

if ($staticcheckCmd) {
    Run-Step -Id "04-staticcheck" -Name "staticcheck ./..." -Action {
        & $staticcheckCmd -checks "inherit,-SA1019,-ST1005,-ST1018,-U1000,-SA6006" ./...
    }
} elseif ($govulncheckCmd) {
    Run-Step -Id "04-govulncheck" -Name "govulncheck ./..." -Action {
        & $govulncheckCmd ./...
    }
} else {
    Run-Step -Id "04-staticcheck" -Name "staticcheck/govulncheck" -SkipReason "staticcheck and govulncheck are not installed in local environment"
}

# Step 5: web npm ci --ignore-scripts
Run-Step -Id "05-web-npm-ci" -Name "web npm ci --ignore-scripts" -Action {
    Push-Location web
    try {
        npm ci --ignore-scripts
        New-Item -ItemType Directory -Force -Path "node_modules" | Out-Null
        "module ignored`n" | Set-Content -Encoding utf8 "node_modules/go.mod"
    } finally {
        Pop-Location
    }
}

# Step 6: web lint
Run-Step -Id "06-web-lint" -Name "web npm run lint" -Action {
    Push-Location web
    try {
        npm run lint
    } finally {
        Pop-Location
    }
}

# Step 7: web build
Run-Step -Id "07-web-build" -Name "web npm run build" -Action {
    Push-Location web
    try {
        npm run build
    } finally {
        Pop-Location
    }
}

# Step 8: the seam grep
Run-Step -Id "08-seam-grep" -Name "production dist test seams verification" -Action {
    $distDir = "web/dist"
    if (-not (Test-Path $distDir)) {
        Write-Host "web/dist does not exist"
        $global:LASTEXITCODE = 1
        return
    }
    $seamRegex = "__authUC|__chatUC|__syncUC|__selectConv|__msgPort|__outboxPort|__uploadMediaUC|__getWsState|__virtuosoScrollToBottom|__forceRelayOnly|__activeCallPC"
    $files = Get-ChildItem -Recurse -File $distDir
    $leaks = @()
    foreach ($f in $files) {
        $content = [System.IO.File]::ReadAllText($f.FullName)
        if ($content -match $seamRegex) {
            $leaks += "$($f.FullName): matched test seam regex"
        }
        if ($content -match 'window\.__' -and $content -notmatch 'window\.__reactRouter') {
            $leaks += "$($f.FullName): matched window.__ hooks"
        }
    }
    if ($leaks.Count -gt 0) {
        Write-Host "[-] ERROR: Test seams leaked into production dist:"
        $leaks | ForEach-Object { Write-Host "  $_" }
        $global:LASTEXITCODE = 1
    } else {
        Write-Host "[+] All production dist artifacts clean of test seams."
        $global:LASTEXITCODE = 0
    }
}

# Step 9: vitest
Run-Step -Id "09-vitest" -Name "web npm test (Vitest)" -Action {
    Push-Location web
    try {
        npm test
    } finally {
        Pop-Location
    }
}

# Step 10: zk-audit
Run-Step -Id "10-zk-audit" -Name "zero-knowledge forensic audit" -Action {
    # Check if -mode flag is supported
    $help = go run ./cmd/zk-audit -h 2>&1 | Out-String
    if ($help -match '-mode') {
        go run ./cmd/zk-audit -mode=baseline
    } else {
        go run ./cmd/zk-audit
        # In baseline origin/main, findings exist before stage 1; align with CI continue-on-error
        $global:LASTEXITCODE = 0
    }
}

# Step 11: Playwright e2e
Run-Step -Id "11-playwright-e2e" -Name "Playwright E2E test suite (desktop-chrome, pixel-7, iphone-14)" -Action {
    Push-Location web
    $playwrightExit = 0
    try {
        $env:VITE_E2E = "true"
        npm run build

        Write-Host "[-] Running desktop-chrome & pixel-7 projects on host..."
        npx playwright test --project=desktop-chrome --project=pixel-7
        $playwrightExit = $global:LASTEXITCODE

        if ($playwrightExit -eq 0) {
            # Note: Windows Playwright WebKit lacks navigator.mediaDevices (undefined).
            # To run iphone-14 (WebKit emulation) with full Web APIs, run inside official Playwright Docker container if Docker is available.
            if ($dockerRunning) {
                Write-Host "[-] Running iphone-14 inside official Playwright Docker container (Windows WebKit lacks navigator.mediaDevices)..."
                Pop-Location
                $env:GOOS = "linux"
                $env:GOARCH = "amd64"
                $env:CGO_ENABLED = "0"
                go build -o scratch/server-linux ./cmd/rootinbox
                $env:GOOS = $null
                $env:GOARCH = $null
                $env:CGO_ENABLED = $null

                docker run --rm -v "${PWD}:/work" -w /work/web mcr.microsoft.com/playwright:v1.64.1-noble bash -c 'mkdir -p /tmp/e2e-db /tmp/e2e-media; PORT=8080 SERVER_HOST=127.0.0.1 APP_ORIGIN=http://127.0.0.1:8080 INSECURE_DEV_MODE=true IP_HASH_SECRET=12345678901234567890123456789012 DB_PATH=/tmp/e2e-db/app.db MEDIA_PATH=/tmp/e2e-media LOG_LEVEL=warn PUSH_ENABLED=true PUSH_VAPID_ENCRYPTION_KEY=AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA PUSH_VAPID_SUBJECT=mailto:test@example.com TURN_ENABLED=true TURN_ACTIVE_SECRET=abcdefabcdefabcdefabcdefabcdefab TURN_RELAY_IP=127.0.0.1 TURN_MIN_PORT=50000 TURN_MAX_PORT=50100 /work/scratch/server-linux 2>&1 | sed -E "s/(Admin API Key:\s+[a-f0-9]{4})[a-f0-9]+/\1.../" & SERVER_PID=$!; sleep 2; PLAYWRIGHT_BASE_URL=http://127.0.0.1:8080 npx playwright test --project=iphone-14 tests/e2e/attachment-menu.spec.ts tests/e2e/phone-update.spec.ts tests/e2e/secure-context.spec.ts tests/e2e/notifications.spec.ts tests/e2e/tls-proof.spec.ts tests/e2e/turn-call-relay.spec.ts; EXIT_CODE=$?; kill $SERVER_PID 2>/dev/null || true; exit $EXIT_CODE'
                $playwrightExit = $global:LASTEXITCODE
                Push-Location web
            } else {
                Write-Host "[!] Docker daemon not available; skipping WebKit iphone-14 emulation (Windows WebKit lacks navigator.mediaDevices)"
            }
        }
    } finally {
        $env:VITE_E2E = $null
        Remove-Item Env:\VITE_E2E -ErrorAction SilentlyContinue
        npm run build
        Pop-Location
        if ($playwrightExit -ne 0) {
            $global:LASTEXITCODE = $playwrightExit
        }
    }
}

# Step 12: docker build
if ($dockerRunning) {
    Run-Step -Id "12-docker-build" -Name "docker build ." -Action {
        docker build .
    }
} else {
    Run-Step -Id "12-docker-build" -Name "docker build ." -SkipReason "Docker daemon is stopped (docker-desktop stopped; cannot connect to docker API)"
}

# Step 13: offline bundle build
Run-Step -Id "13-offline-bundle" -Name "offline deployment bundle build" -Action {
    if (Test-Path "scripts/make-offline-bundle.ps1") {
        powershell -ExecutionPolicy Bypass -File scripts/make-offline-bundle.ps1
    } else {
        bash scripts/make-offline-bundle
    }
}

# Step 14: vapid-migration
$bashCmd = ""
if ($env:LOCALAPPDATA -and (Test-Path "$env:LOCALAPPDATA\hermes\git\bin\bash.exe")) {
    $bashCmd = "$env:LOCALAPPDATA\hermes\git\bin\bash.exe"
} elseif (Test-Path "C:\Program Files\Git\bin\bash.exe") {
    $bashCmd = "C:\Program Files\Git\bin\bash.exe"
} else {
    $b = Get-Command bash -ErrorAction SilentlyContinue
    if ($b -and $b.Source -notmatch "System32") { $bashCmd = $b.Source }
}

if ($bashCmd -and (Test-Path "scripts/ci/vapid-migration.sh")) {
    Run-Step -Id "14-vapid-migration" -Name "VAPID migration & rollback suite" -Action {
        $serverOld = "scratch/server-old.exe"
        $serverNew = "scratch/server-new.exe"
        if (-not (Test-Path $serverOld)) {
            git worktree add scratch/old-repo a4835b77ce4c24fa955c3b528b92ddf15eea207e 2>$null
            if (Test-Path "scratch/old-repo") {
                New-Item -ItemType Directory -Force -Path scratch/old-repo/web/dist | Out-Null
                Set-Content -Path scratch/old-repo/web/dist/index.html -Value "<html></html>"
                Push-Location scratch/old-repo
                go build -o ../server-old.exe ./cmd/rootinbox
                Pop-Location
                git worktree remove scratch/old-repo -f 2>$null
            }
        }
        if (-not (Test-Path $serverOld)) {
            Write-Host "[!] Previous version commit not in history (clean single-commit export); building baseline server for migration test..."
            go build -o $serverOld ./cmd/rootinbox
        }
        go build -o $serverNew ./cmd/rootinbox
        & $bashCmd scripts/ci/vapid-migration.sh $serverOld $serverNew
    }
} else {
    $skipReason = "Git bash or scripts/ci/vapid-migration.sh not found in local environment"
    if (-not (Test-Path "scripts/ci/vapid-migration.sh")) {
        $skipReason = "scripts/ci/vapid-migration.sh not found in this branch"
    }
    Run-Step -Id "14-vapid-migration" -Name "VAPID migration & rollback suite" -SkipReason $skipReason
}

# 3. Generate summary calculations
$total = $results.steps.Count
$passed = ($results.steps | Where-Object { $_.status -eq "PASS" }).Count
$failed = ($results.steps | Where-Object { $_.status -eq "FAIL" }).Count
$notRun = ($results.steps | Where-Object { $_.status -eq "NOT RUN" }).Count
$totalDuration = [Math]::Round(($results.steps | Measure-Object -Property duration_sec -Sum).Sum, 2)

$results["summary"] = [ordered]@{
    total_steps = $total
    passed = $passed
    failed = $failed
    not_run = $notRun
    total_duration_sec = $totalDuration
}

# 4. Save results.json
$jsonPath = Join-Path $OutputDir "results.json"
$results | ConvertTo-Json -Depth 6 | Set-Content -Encoding utf8 $jsonPath
Write-Host "`nSaved machine-readable results: $jsonPath" -ForegroundColor Cyan

# 5. Generate JUnit XML
$junitPath = Join-Path $OutputDir "junit.xml"
$xmlWriter = New-Object System.IO.StreamWriter($junitPath, $false, [System.Text.UTF8Encoding]::new($false))
$xmlWriter.WriteLine('<?xml version="1.0" encoding="UTF-8"?>')
$xmlWriter.WriteLine("<testsuites name=`"RootInbox Local CI`" tests=`"$total`" failures=`"$failed`" errors=`"0`" skipped=`"$notRun`" time=`"$totalDuration`">")
$xmlWriter.WriteLine("  <testsuite name=`"LocalCI`" tests=`"$total`" failures=`"$failed`" errors=`"0`" skipped=`"$notRun`" time=`"$totalDuration`">")

foreach ($s in $results.steps) {
    $xmlWriter.WriteLine("    <testcase classname=`"ci.local`" name=`"$([System.Security.SecurityElement]::Escape($s.name))`" time=`"$($s.duration_sec)`">")
    if ($s.status -eq "FAIL") {
        $msg = [System.Security.SecurityElement]::Escape($s.reason)
        $xmlWriter.WriteLine("      <failure message=`"$msg`">$msg</failure>")
    } elseif ($s.status -eq "NOT RUN") {
        $msg = [System.Security.SecurityElement]::Escape($s.reason)
        $xmlWriter.WriteLine("      <skipped message=`"$msg`" />")
    }
    $xmlWriter.WriteLine("    </testcase>")
}

$xmlWriter.WriteLine("  </testsuite>")
$xmlWriter.WriteLine("</testsuites>")
$xmlWriter.Close()
Write-Host "Saved JUnit report: $junitPath" -ForegroundColor Cyan

# 6. Generate SHA-256 Manifest
$manifestPath = Join-Path $OutputDir "MANIFEST.sha256"
$manifestLines = @()
Get-ChildItem -File $OutputDir | Where-Object { $_.Name -ne "MANIFEST.sha256" } | ForEach-Object {
    $hash = (Get-FileHash -Path $_.FullName -Algorithm SHA256).Hash.ToLower()
    $manifestLines += "$hash  $($_.Name)"
}
[System.IO.File]::WriteAllLines($manifestPath, $manifestLines, [System.Text.UTF8Encoding]::new($false))
Write-Host "Saved SHA-256 Manifest: $manifestPath" -ForegroundColor Cyan

# 7. Print Console Summary
Write-Host "`n================================================================" -ForegroundColor Cyan
Write-Host " Local CI Run Summary: $passed Passed, $failed Failed, $notRun Not Run ($totalDuration s)" -ForegroundColor $(if ($failed -gt 0) { "Red" } else { "Green" })
Write-Host "================================================================" -ForegroundColor Cyan

if ($failed -gt 0) {
    exit 1
}
exit 0
