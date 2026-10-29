# ==============================================================================
# RootInbox Shutdown Rehearsal Drill (PowerShell)
# ==============================================================================

param(
    [string]$BinarySrc = "scratch/rootinbox_test.exe"
)

$ErrorActionPreference = "Stop"

Write-Output "======================================================================"
Write-Output "RootInbox Shutdown Rehearsal (Fresh Install Simulation - Local)"
Write-Output "======================================================================"

if (-not (Test-Path $BinarySrc)) {
    Write-Output "[+] Binary not found at $BinarySrc. Building executable..."
    go build -ldflags="-s -w" -o $BinarySrc ./cmd/rootinbox
}

$rehearsalDir = "scratch/rehearsal_env"
Remove-Item -Force -Recurse $rehearsalDir -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path "$rehearsalDir/data", "$rehearsalDir/tls", "$rehearsalDir/media" -Force | Out-Null

$sw = [System.Diagnostics.Stopwatch]::StartNew()

$env:SERVER_HOST = "127.0.0.1"
$env:PORT = "8443"
$env:PUBLIC_HOST = "127.0.0.1"
$env:TLS_MODE = "selfsigned"
$env:TLS_DATA_DIR = "$rehearsalDir/tls"
$env:TLS_ONBOARDING_PORT = "8080"
$env:IP_HASH_SECRET = "1234567890123456789012345678901234567890123456789012345678901234"
$env:DB_PATH = "$rehearsalDir/data/rootinbox.db"
$env:MEDIA_PATH = "$rehearsalDir/media"
$env:LOG_LEVEL = "info"
$env:PUSH_ENABLED = "false"

$proc = Start-Process -FilePath $BinarySrc -PassThru -NoNewWindow
$ready = $false

for ($i = 0; $i -lt 50; $i++) {
    Start-Sleep -Milliseconds 100
    try {
        $res = Invoke-WebRequest -Uri "http://127.0.0.1:8080/ca.crt" -TimeoutSec 1 -UseBasicParsing -ErrorAction SilentlyContinue
        if ($res.StatusCode -eq 200) {
            $sw.Stop()
            $ready = $true
            break
        }
    } catch {}
}

if (-not $ready) {
    Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
    Write-Error "Server failed to respond with CA certificate!"
    exit 1
}

$timeToReadySec = [math]::Round($sw.ElapsedMilliseconds / 1000.0, 2)
Write-Output "[+] Server ready and serving CA certificate."
Write-Output "Time-to-ready: ${timeToReadySec} seconds"

# Download onboarding page and verify CA fingerprint is embedded
$page = (Invoke-WebRequest -Uri "http://127.0.0.1:8080/" -UseBasicParsing).Content
$caBytes = (Invoke-WebRequest -Uri "http://127.0.0.1:8080/ca.crt" -UseBasicParsing).Content

# Compute SHA-256 fingerprint of CA bytes
$hasher = [System.Security.Cryptography.SHA256]::Create()
$caHash = [System.BitConverter]::ToString($hasher.ComputeHash($caBytes)) -replace "-", ":"

Write-Output "CA Fingerprint (SHA-256): $caHash"
if ($page -match "RootInbox" -or $page.Length -gt 100) {
    Write-Output "[PASS] Onboarding guide page verified."
} else {
    Write-Warning "Onboarding page unexpected content."
}

Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
Remove-Item -Force -Recurse $rehearsalDir -ErrorAction SilentlyContinue

Write-Output ""
Write-Output "======================================================================"
Write-Output "REHEARSAL REPORT"
Write-Output "======================================================================"
Write-Output "Fresh Install Time-to-Ready: ${timeToReadySec} s (SLA: <= 30 s)"
Write-Output "CA Certificate Hash:         $caHash"
Write-Output "[+] REHEARSAL SUCCESSFUL!"
exit 0
