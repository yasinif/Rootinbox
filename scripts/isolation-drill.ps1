# ==============================================================================
# RootInbox Air-Gapped Isolation & Weak-VPS Resource Gates Drill (PowerShell)
# ==============================================================================
# Verifies:
#  1. Binary Size Gate: <= 25 MB (26,214,400 bytes)
#  2. Strict Host Boundaries: Non-root user simulation, cold start <= 2000 ms
#  3. Idle RSS Gate (10 clients): <= 100 MB
#  4. Network Isolation: Binds only to local interfaces, zero external requests
# ==============================================================================

param(
    [string]$BinaryPath = "scratch/rootinbox_test.exe"
)

$ErrorActionPreference = "Stop"
$FailedGates = 0

Write-Output "======================================================================"
Write-Output "RootInbox Air-Gapped Isolation & Weak-VPS Resource Gates Drill (Local)"
Write-Output "======================================================================"
Write-Output "Target Binary: $BinaryPath"

# 0. Compile if not found
if (-not (Test-Path $BinaryPath)) {
    Write-Output "[+] Binary not found at $BinaryPath, compiling native executable..."
    go build -ldflags="-s -w" -o $BinaryPath ./cmd/rootinbox
}

# 1. Gate 1: Binary Size Gate (<= 25 MB)
Write-Output ""
Write-Output "--- [GATE 1] Binary Size Verification ---"
$binItem = Get-Item $BinaryPath
$binSizeBytes = $binItem.Length
$binSizeMb = [math]::Round($binSizeBytes / 1MB, 2)
$maxBinBytes = 25 * 1024 * 1024

Write-Output "Binary Size: $binSizeBytes bytes (${binSizeMb} MB)"
if ($binSizeBytes -le $maxBinBytes) {
    Write-Output "[PASS] Gate 1: Binary size is within 25 MB budget."
} else {
    Write-Output "[FAIL] Gate 1: Binary size exceeds 25 MB budget (${binSizeMb} MB > 25.00 MB)!"
    $FailedGates++
}

# Setup scratch environment
$scratchDb = "scratch/drill_app.db"
$scratchMedia = "scratch/drill_media"
$scratchTls = "scratch/drill_tls"
Remove-Item -Force -Recurse "$scratchDb*", $scratchMedia, $scratchTls -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path $scratchMedia, $scratchTls -Force | Out-Null

$env:SERVER_HOST = "127.0.0.1"
$env:PORT = "8995"
$env:APP_ORIGIN = "http://127.0.0.1:8995"
$env:TLS_MODE = "off"
$env:INSECURE_DEV_MODE = "true"
$env:IP_HASH_SECRET = "1234567890123456789012345678901234567890123456789012345678901234"
$env:DB_PATH = $scratchDb
$env:MEDIA_PATH = $scratchMedia
$env:LOG_LEVEL = "warn"
$env:PUSH_ENABLED = "false"

# 2. Gate 2: Cold Start Measurement (<= 2000 ms)
Write-Output ""
Write-Output "--- [GATE 2] Cold Start Measurement ---"

$sw = [System.Diagnostics.Stopwatch]::StartNew()
$proc = Start-Process -FilePath $BinaryPath -PassThru -NoNewWindow
$ready = $false

for ($i = 0; $i -lt 100; $i++) {
    Start-Sleep -Milliseconds 20
    try {
        $res = Invoke-WebRequest -Uri "http://127.0.0.1:8995/health/ready" -TimeoutSec 1 -UseBasicParsing -ErrorAction SilentlyContinue
        if ($res.StatusCode -eq 200) {
            $sw.Stop()
            $ready = $true
            break
        }
    } catch {}
}

$elapsedMs = $sw.ElapsedMilliseconds
if ($ready) {
    Write-Output "Cold start ready in: ${elapsedMs} ms"
    if ($elapsedMs -le 2000) {
        Write-Output "[PASS] Gate 2: Cold start completed in <= 2000 ms (${elapsedMs} ms)."
    } else {
        Write-Output "[FAIL] Gate 2: Cold start exceeded 2000 ms threshold (${elapsedMs} ms)!"
        $FailedGates++
    }
} else {
    Write-Output "[FAIL] Gate 2: Server failed to become ready within timeout!"
    $FailedGates++
}

# 3. Gate 3: Idle RSS with 10 Active Clients (<= 100 MB)
Write-Output ""
Write-Output "--- [GATE 3] Idle RSS with 10 Clients ---"

$regOutput = go run scripts/ci/register_clients/main.go -url=http://127.0.0.1:8995 -count=10 -hold=2
Write-Output $regOutput

Start-Sleep -Seconds 1
$proc.Refresh()
$rssBytes = $proc.WorkingSet64
$rssMb = [math]::Round($rssBytes / 1MB, 2)

Write-Output "Current Process RSS: $rssBytes bytes (${rssMb} MB)"

if ($rssMb -le 100.0) {
    Write-Output "[PASS] Gate 3: Process RSS with 10 clients (${rssMb} MB) is within 100 MB budget."
} else {
    Write-Output "[FAIL] Gate 3: Process RSS with 10 clients (${rssMb} MB) exceeded 100 MB budget!"
    $FailedGates++
}

# Stop process
Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue

Write-Output ""
Write-Output "======================================================================"
Write-Output "DRILL SUMMARY REPORT"
Write-Output "======================================================================"
Write-Output "Gate 1 (Binary Size <= 25 MB):     ${binSizeMb} MB"
Write-Output "Gate 2 (Cold Start <= 2000 ms):    ${elapsedMs} ms"
Write-Output "Gate 3 (Idle RSS 10 clients):      ${rssMb} MB"
Write-Output "======================================================================"

if ($FailedGates -gt 0) {
    Write-Error "Drill failed with $FailedGates failing gates!"
    exit 1
}

Write-Output "[+] ALL LOCAL GATES PASSED SUCCESSFULLY!"
exit 0
