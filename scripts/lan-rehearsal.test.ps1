# ==============================================================================
# Unit & Integration Tests for LAN Rehearsal Harness
# ==============================================================================

[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"

Write-Host "================================================================================" -ForegroundColor Cyan
Write-Host " Running RootInbox LAN Rehearsal Test Suite" -ForegroundColor Cyan
Write-Host "================================================================================" -ForegroundColor Cyan

$testCount = 0
$passCount = 0

function Assert-Test {
    param(
        [string]$Description,
        [scriptblock]$Test
    )
    $script:testCount++
    Write-Host "[*] TEST $script:testCount: $Description... " -NoNewline
    try {
        & $Test
        Write-Host "PASS" -ForegroundColor Green
        $script:passCount++
    } catch {
        Write-Host "FAIL" -ForegroundColor Red
        Write-Host "    $($_.Exception.Message)" -ForegroundColor Red
    }
}

# ------------------------------------------------------------------------------
# Test 1: Invalid IP Format Rejected
# ------------------------------------------------------------------------------
Assert-Test -Description "lan-rehearsal.ps1 rejects invalid IP formats" -Test {
    $proc = Start-Process -FilePath "powershell.exe" -ArgumentList "-ExecutionPolicy Bypass -File scripts/lan-rehearsal.ps1 -LanIp not-an-ip -Headless" -Wait -PassThru -NoNewWindow
    if ($proc.ExitCode -eq 0) {
        throw "Expected non-zero exit code for invalid IP, but got 0"
    }
}

# ------------------------------------------------------------------------------
# Test 2: Stop Switch with No Active Process Exits 0
# ------------------------------------------------------------------------------
Assert-Test -Description "lan-rehearsal.ps1 -Stop exits cleanly when no server is running" -Test {
    $out = powershell -ExecutionPolicy Bypass -File scripts/lan-rehearsal.ps1 -DataDir "scratch/nonexistent_dir" -Stop 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0) {
        throw "Expected exit code 0 from -Stop on empty state, got $LASTEXITCODE"
    }
}

# ------------------------------------------------------------------------------
# Test 3: Headless Lifecycle: Start, Probe, and Stop
# ------------------------------------------------------------------------------
Assert-Test -Description "lan-rehearsal full lifecycle (Start -> Check -> Stop)" -Test {
    $testDir = "scratch/test_lan_lifecycle"
    Remove-Item -Recurse -Force $testDir -ErrorAction SilentlyContinue

    $testPort = 18443
    $testOnboarding = 18080
    $testTurn = 13478

    try {
        # 1. Start server in Headless mode on 127.0.0.1
        & "scripts/lan-rehearsal.ps1" -LanIp "127.0.0.1" -Port $testPort -OnboardingPort $testOnboarding -TurnPort $testTurn -DataDir $testDir -Headless

        $pidFile = Join-Path $testDir "server.pid"
        if (-not (Test-Path $pidFile)) {
            throw "server.pid was not created at $pidFile"
        }
        $pidVal = (Get-Content $pidFile).Trim()
        Write-Host " (Server running with PID: $pidVal) " -NoNewline

        # 2. Run verification probe
        & "scripts/lan-rehearsal-check.ps1" -LanIp "127.0.0.1" -Port $testPort -OnboardingPort $testOnboarding -TurnPort $testTurn

        # 3. Stop server
        & "scripts/lan-rehearsal.ps1" -DataDir $testDir -Stop

        if (Test-Path $pidFile) {
            throw "server.pid still exists after -Stop"
        }

        # Ensure process terminated
        $proc = Get-Process -Id ([int]$pidVal) -ErrorAction SilentlyContinue
        if ($null -ne $proc -and -not $proc.HasExited) {
            throw "Process $pidVal is still alive after -Stop"
        }
    } finally {
        Remove-Item -Recurse -Force $testDir -ErrorAction SilentlyContinue
    }
}

Write-Host "--------------------------------------------------------------------------------" -ForegroundColor Gray
Write-Host " Test Results: $passCount / $testCount tests passed." -ForegroundColor $(if ($passCount -eq $testCount) { "Green" } else { "Red" })
Write-Host "================================================================================" -ForegroundColor Cyan

if ($passCount -ne $testCount) {
    exit 1
}
exit 0
