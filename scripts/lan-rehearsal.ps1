# ==============================================================================
# RootInbox LAN Rehearsal Harness (PowerShell)
# Enables multi-device end-to-end rehearsal on local physical Wi-Fi / LAN networks
# ==============================================================================

[CmdletBinding()]
param(
    [string]$LanIp = "",
    [int]$Port = 8443,
    [int]$OnboardingPort = 8080,
    [int]$TurnPort = 3478,
    [string]$DataDir = "scratch/lan_rehearsal",
    [string]$BinarySrc = "scratch/rootinbox_lan.exe",
    [switch]$Headless,
    [switch]$Stop,
    [switch]$CheckOnly,
    [switch]$NoBuild,
    [switch]$ForceRebuild
)

$ErrorActionPreference = "Stop"

function Write-Banner {
    param([string]$Text)
    Write-Host "`n================================================================================" -ForegroundColor Cyan
    Write-Host " $Text" -ForegroundColor Cyan
    Write-Host "================================================================================" -ForegroundColor Cyan
}

function Get-LanCandidates {
    $candidates = @()
    try {
        $adapters = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop |
            Where-Object {
                $_.IPAddress -notlike "127.*" -and
                $_.IPAddress -notlike "169.254.*" -and
                $_.IPAddress -ne "0.0.0.0"
            }
        foreach ($a in $adapters) {
            $alias = $a.InterfaceAlias
            $isVirtual = $alias -match "(?i)(loopback|vethernet|wsl|docker|hyper-v|virtualbox|vmware|tailscale|zerotier)"
            $candidates += [PSCustomObject]@{
                IPAddress      = $a.IPAddress
                InterfaceAlias = $alias
                IsVirtual      = $isVirtual
            }
        }
    } catch {
        $interfaces = [System.Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces()
        foreach ($iface in $interfaces) {
            if ($iface.OperationalStatus -ne [System.Net.NetworkInformation.OperationalStatus]::Up) { continue }
            $props = $iface.GetIPProperties()
            foreach ($addr in $props.UnicastAddresses) {
                if ($addr.Address.AddressFamily -eq [System.Net.Sockets.AddressFamily]::InterNetwork) {
                    $ipStr = $addr.Address.ToString()
                    if ($ipStr -notlike "127.*" -and $ipStr -notlike "169.254.*") {
                        $isVirtual = $iface.Description -match "(?i)(virtual|wsl|docker|hyper-v|vmware|tailscale)"
                        $candidates += [PSCustomObject]@{
                            IPAddress      = $ipStr
                            InterfaceAlias = $iface.Name
                            IsVirtual      = $isVirtual
                        }
                    }
                }
            }
        }
    }
    return $candidates
}

# --- 1. Handle -Stop Switch ---
if ($Stop) {
    Write-Banner "Stopping RootInbox LAN Rehearsal Server"
    $pidFile = Join-Path $DataDir "server.pid"
    $stopped = $false

    if (Test-Path $pidFile) {
        $savedPid = Get-Content $pidFile -ErrorAction SilentlyContinue
        if ($savedPid -match '^\d+$') {
            try {
                $proc = Get-Process -Id ([int]$savedPid) -ErrorAction SilentlyContinue
                if ($null -ne $proc) {
                    Write-Host "[*] Stopping server process (PID: $savedPid)..." -ForegroundColor Yellow
                    Stop-Process -Id ([int]$savedPid) -Force -ErrorAction SilentlyContinue
                    $stopped = $true
                }
            } catch {}
        }
        Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
    }

    $lingering = Get-Process -Name "rootinbox_lan" -ErrorAction SilentlyContinue
    if ($lingering) {
        foreach ($p in $lingering) {
            Write-Host "[*] Terminating lingering process (PID: $($p.Id))..." -ForegroundColor Yellow
            Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
            $stopped = $true
        }
    }

    if ($stopped) {
        Write-Host "[+] Server successfully stopped." -ForegroundColor Green
    } else {
        Write-Host "[i] No active rehearsal server found." -ForegroundColor Gray
    }
    return
}

# --- 2. IP Resolution ---
$selectedIp = $LanIp
if (-not $selectedIp) {
    $allCandidates = Get-LanCandidates
    $physical = $allCandidates | Where-Object { -not $_.IsVirtual }
    $usable = if ($physical.Count -gt 0) { $physical } else { $allCandidates }

    if ($usable.Count -eq 0) {
        Write-Warning "No active LAN IPv4 address detected. Falling back to 127.0.0.1 (Loopback only)."
        $selectedIp = "127.0.0.1"
    } elseif ($usable.Count -eq 1) {
        $selectedIp = $usable[0].IPAddress
        Write-Host "[+] Auto-detected single LAN interface: $selectedIp ($($usable[0].InterfaceAlias))" -ForegroundColor Green
    } else {
        # Multiple candidates found
        if ($Headless -or (-not [Environment]::UserInteractive) -or ($Host.Name -match "ServerRemoteHost")) {
            # Prefer 192.168.x.x, then 10.x.x.x, then 172.x.x.x
            $preferred = $usable | Where-Object { $_.IPAddress -like "192.168.*" }
            if (-not $preferred) { $preferred = $usable | Where-Object { $_.IPAddress -like "10.*" } }
            if (-not $preferred) { $preferred = $usable }
            $selectedIp = $preferred[0].IPAddress
            Write-Host "[+] Headless mode: selected preferred LAN IP: $selectedIp ($($preferred[0].InterfaceAlias))" -ForegroundColor Green
        } else {
            Write-Host "`nMultiple active network interfaces detected:" -ForegroundColor Yellow
            for ($i = 0; $i -lt $usable.Count; $i++) {
                $item = $usable[$i]
                $tag = if ($item.IsVirtual) { "[virtual]" } else { "[physical]" }
                Write-Host "  [$($i + 1)] $($item.IPAddress) - $($item.InterfaceAlias) $tag" -ForegroundColor White
            }
            $choice = Read-Host "`nEnter number of the interface to use (default: 1)"
            $idx = 0
            if ($choice -match '^\d+$') {
                $idx = [int]$choice - 1
                if ($idx -lt 0 -or $idx -ge $usable.Count) { $idx = 0 }
            }
            $selectedIp = $usable[$idx].IPAddress
            Write-Host "[+] Selected LAN IP: $selectedIp ($($usable[$idx].InterfaceAlias))" -ForegroundColor Green
        }
    }
}

# Validate selected IP
$parsedIp = $null
if (-not [System.Net.IPAddress]::TryParse($selectedIp, [ref]$parsedIp)) {
    Write-Host "[-] Invalid IPv4 address format: '$selectedIp'" -ForegroundColor Red
    exit 1
}

# --- 3. Handle -CheckOnly Switch ---
if ($CheckOnly) {
    if (Test-Path "scripts/lan-rehearsal-check.ps1") {
        & "scripts/lan-rehearsal-check.ps1" -LanIp $selectedIp -Port $Port -OnboardingPort $OnboardingPort -TurnPort $TurnPort
        exit $LASTEXITCODE
    } else {
        Write-Error "Check script 'scripts/lan-rehearsal-check.ps1' not found."
        exit 1
    }
}

# --- 4. Build RootInbox Server Binary ---
if ((-not (Test-Path $BinarySrc)) -or $ForceRebuild) {
    if ($NoBuild) {
        Write-Error "Binary not found at $BinarySrc and -NoBuild was requested."
        exit 1
    }
    Write-Host "[*] Compiling RootInbox server executable ($BinarySrc)..." -ForegroundColor Yellow
    $buildDir = Split-Path -Parent $BinarySrc
    if ($buildDir -and -not (Test-Path $buildDir)) {
        New-Item -ItemType Directory -Path $buildDir -Force | Out-Null
    }
    & go build -ldflags="-s -w" -o $BinarySrc ./cmd/rootinbox
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Failed to build RootInbox server binary."
        exit 1
    }
    Write-Host "[+] Build successful." -ForegroundColor Green
}

# --- 5. Prepare Rehearsal Environment ---
$rehearsalDataDir = Join-Path $DataDir "data"
$rehearsalTlsDir = Join-Path $DataDir "tls"
$rehearsalMediaDir = Join-Path $DataDir "media"
New-Item -ItemType Directory -Path $rehearsalDataDir, $rehearsalTlsDir, $rehearsalMediaDir -Force | Out-Null

$pidFile = Join-Path $DataDir "server.pid"
$logFile = Join-Path $DataDir "server.log"

# Define distinct 32-byte rehearsal secrets
$turnSecret = "lan_rehearsal_turn_secret_32bytes_minimum_length!"
$ipHashSecret = "lan_rehearsal_iphash_secret_32bytes_minimum_length!"

# --- 6. Launch Rehearsal Server ---
Write-Host "[*] Launching RootInbox server on $selectedIp (HTTPS: $Port, Onboarding: $OnboardingPort, TURN: $TurnPort)..." -ForegroundColor Yellow

    $psi = [System.Diagnostics.ProcessStartInfo]::new()
    $psi.FileName = (Resolve-Path $BinarySrc).Path
    $psi.WorkingDirectory = (Resolve-Path .).Path
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true

    $psi.EnvironmentVariables["SERVER_HOST"] = "0.0.0.0"
    $psi.EnvironmentVariables["PORT"] = "$Port"
    $psi.EnvironmentVariables["PUBLIC_HOST"] = $selectedIp
    $psi.EnvironmentVariables["TLS_MODE"] = "selfsigned"
    $psi.EnvironmentVariables["TLS_DATA_DIR"] = (Resolve-Path $rehearsalTlsDir).Path
    $psi.EnvironmentVariables["TLS_ONBOARDING_PORT"] = "$OnboardingPort"
    $psi.EnvironmentVariables["DB_PATH"] = Join-Path (Resolve-Path $rehearsalDataDir).Path "rootinbox.db"
    $psi.EnvironmentVariables["MEDIA_PATH"] = (Resolve-Path $rehearsalMediaDir).Path
    $psi.EnvironmentVariables["LOG_LEVEL"] = "info"
    $psi.EnvironmentVariables["ALLOW_SELF_REGISTRATION"] = "true"
    $psi.EnvironmentVariables["TURN_ENABLED"] = "true"
    $psi.EnvironmentVariables["TURN_LISTEN_ADDR"] = "0.0.0.0:$TurnPort"
    $psi.EnvironmentVariables["TURN_REALM"] = $selectedIp
    $psi.EnvironmentVariables["TURN_ACTIVE_SECRET"] = $turnSecret
    $psi.EnvironmentVariables["IP_HASH_SECRET"] = $ipHashSecret
    $psi.EnvironmentVariables["PUSH_ENABLED"] = "false"
    $psi.EnvironmentVariables["INSECURE_DEV_MODE"] = "true"

    $serverProc = [System.Diagnostics.Process]::Start($psi)

if ($null -eq $serverProc -or $serverProc.HasExited) {
    Write-Host "[-] Failed to start RootInbox server process." -ForegroundColor Red
    exit 1
}

$serverProc.Id | Out-File -FilePath $pidFile -Encoding ascii

# --- 7. Poll for Server Readiness ---
Write-Host "[*] Waiting for server and TLS engine initialization..." -NoNewline
$ready = $false
$sw = [System.Diagnostics.Stopwatch]::StartNew()

for ($attempt = 0; $attempt -lt 100; $attempt++) {
    Start-Sleep -Milliseconds 150
    Write-Host "." -NoNewline
    if ($serverProc.HasExited) {
        Write-Host "`n[-] Server process terminated unexpectedly with code $($serverProc.ExitCode)." -ForegroundColor Red
        if (Test-Path $logFile) {
            Get-Content $logFile -Tail 20 | Write-Host -ForegroundColor DarkGray
        }
        exit 1
    }

    try {
        $onboardingRes = Invoke-WebRequest -Uri "http://127.0.0.1:$OnboardingPort/ca.crt" -TimeoutSec 1 -UseBasicParsing -ErrorAction SilentlyContinue
        if ($onboardingRes.StatusCode -eq 200) {
            $ready = $true
            break
        }
    } catch {}
}
$sw.Stop()
Write-Host ""

if (-not $ready) {
    Write-Error "Timeout: RootInbox server did not become ready within 15 seconds."
    Stop-Process -Id $serverProc.Id -Force -ErrorAction SilentlyContinue
    exit 1
}

# --- 8. Compute CA Certificate Hash ---
$caCertPath = Join-Path $rehearsalTlsDir "ca.crt"
$caHash = "UNKNOWN"
if (Test-Path $caCertPath) {
    $caBytes = [System.IO.File]::ReadAllBytes($caCertPath)
    $hasher = [System.Security.Cryptography.SHA256]::Create()
    $caHash = [System.BitConverter]::ToString($hasher.ComputeHash($caBytes)) -replace "-", ":"
} else {
    try {
        $caBytes = (Invoke-WebRequest -Uri "http://127.0.0.1:$OnboardingPort/ca.crt" -UseBasicParsing).Content
        $hasher = [System.Security.Cryptography.SHA256]::Create()
        $caHash = [System.BitConverter]::ToString($hasher.ComputeHash($caBytes)) -replace "-", ":"
    } catch {}
}

# --- 9. Display Rehearsal Status Banner ---
Write-Banner "ROOTINBOX LAN REHEARSAL IS READY!"

Write-Host " [STATUS] Server is running in Self-Signed TLS Mode (Process PID: $($serverProc.Id))" -ForegroundColor Green
Write-Host " [READY]  Time to ready: $([math]::Round($sw.ElapsedMilliseconds / 1000.0, 2))s" -ForegroundColor Green
Write-Host ""
Write-Host " NETWORK ACCESS POINTS:" -ForegroundColor Yellow
Write-Host "  * Web Application (HTTPS):     https://${selectedIp}:${Port}" -ForegroundColor Cyan
Write-Host "  * Health Check Endpoint:       https://${selectedIp}:${Port}/healthz" -ForegroundColor White
Write-Host "  * CA Certificate Onboarding:   http://${selectedIp}:${OnboardingPort}" -ForegroundColor Cyan
Write-Host "  * CA Certificate Download:     http://${selectedIp}:${OnboardingPort}/ca.crt" -ForegroundColor White
Write-Host "  * Embedded TURN Relay Server:  ${selectedIp}:${TurnPort} (UDP/TCP)" -ForegroundColor White
Write-Host "  * CA SHA-256 Fingerprint:      $caHash" -ForegroundColor Magenta
Write-Host ""
Write-Host " --------------------------------------------------------------------------------" -ForegroundColor Gray
Write-Host " WINDOWS FIREWALL REMINDER:" -ForegroundColor Yellow
Write-Host " If mobile devices on LAN cannot connect, run the following PowerShell command as Administrator:" -ForegroundColor Gray
Write-Host " New-NetFirewallRule -DisplayName 'RootInbox Rehearsal' -Direction Inbound -LocalPort $Port,$OnboardingPort,$TurnPort -Protocol TCP -Action Allow" -ForegroundColor DarkCyan
Write-Host " New-NetFirewallRule -DisplayName 'RootInbox Rehearsal TURN UDP' -Direction Inbound -LocalPort $TurnPort -Protocol UDP -Action Allow" -ForegroundColor DarkCyan
Write-Host " --------------------------------------------------------------------------------" -ForegroundColor Gray
Write-Host ""
Write-Host " MULTI-DEVICE REHEARSAL CHECKLIST:" -ForegroundColor Yellow
Write-Host "  1. Connect your smartphone / second device to the same Wi-Fi router." -ForegroundColor White
Write-Host "  2. Open mobile browser to: https://${selectedIp}:${Port}" -ForegroundColor White
Write-Host "     - In Chrome: If certificate warning appears, tap 'Advanced' -> 'Proceed to ${selectedIp}'" -ForegroundColor White
Write-Host "     - Or visit http://${selectedIp}:${OnboardingPort} to download and install the CA root cert." -ForegroundColor White
Write-Host "  3. Register User A on your desktop browser, and User B on your mobile device." -ForegroundColor White
Write-Host "  4. Exchange messages, share attachments, and initiate an Audio/Video call." -ForegroundColor White
Write-Host "  5. Verify call media relays cleanly via LAN TURN without packet leaks." -ForegroundColor White
Write-Host ""

if ($Headless) {
    Write-Host "[i] Running in Headless mode. Server process PID: $($serverProc.Id)" -ForegroundColor Green
    return
}

Write-Host "================================================================================" -ForegroundColor Cyan
Write-Host " Press [Q] or [Enter] to terminate the rehearsal server..." -ForegroundColor Yellow
Write-Host "================================================================================" -ForegroundColor Cyan

$null = Read-Host

Write-Host "`n[*] Stopping rehearsal server (PID: $($serverProc.Id))..." -ForegroundColor Yellow
try {
    Stop-Process -Id $serverProc.Id -Force -ErrorAction SilentlyContinue
} catch {}

if (Test-Path $pidFile) {
    Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
}

Write-Host "[+] Rehearsal server stopped cleanly. Goodbye!" -ForegroundColor Green
return
