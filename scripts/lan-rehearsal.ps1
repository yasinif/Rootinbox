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
    [string]$UseBinary = "",
    [switch]$InstallCa,
    [switch]$RemoveCa,
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

function Invoke-SelfCheck {
    param(
        [string]$TargetIp,
        [int]$HttpsPort,
        [string]$TlsDir
    )
    Write-Banner "RUNNING LAN REHEARSAL SELF-CHECK"
    $allPassed = $true
    $checks = @()

    $curlCmd = Get-Command "curl.exe" -ErrorAction SilentlyContinue

    function Get-HttpsUrl {
        param([string]$Url)
        if ($curlCmd) {
            $raw = & curl.exe -k -s -i -m 6 $Url 2>&1
            $text = [string]::Join("`n", $raw)
            $parts = $text -split "(?:\r?\n){2}", 2
            $hdr = if ($parts.Count -gt 0) { $parts[0] } else { "" }
            $bdy = if ($parts.Count -gt 1) { $parts[1] } else { "" }
            return [PSCustomObject]@{ Headers = $hdr; Body = $bdy; Raw = $text }
        } else {
            [System.Net.ServicePointManager]::ServerCertificateValidationCallback = { $true }
            [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.SecurityProtocolType]::Tls12
            $res = Invoke-WebRequest -Uri $Url -TimeoutSec 6 -UseBasicParsing -ErrorAction Stop
            $ct = if ($res.Headers["Content-Type"]) { $res.Headers["Content-Type"] } else { "" }
            return [PSCustomObject]@{ Headers = "Content-Type: $ct`nStatus: $($res.StatusCode)"; Body = $res.Content; Raw = $res.Content }
        }
    }

    # 1. /health/ready check
    $readyUrl = "https://${TargetIp}:${HttpsPort}/health/ready"
    $checkReady = [PSCustomObject]@{ Name = "/health/ready is healthy JSON (not SPA shell)"; Status = "WAIT"; Hint = "" }
    try {
        $res = Get-HttpsUrl -Url $readyUrl
        if ($res.Headers -match "200" -and ($res.Body -match '"status"\s*:\s*"pass"' -or $res.Body -match '"status"\s*:\s*"ok"') -and $res.Body -notmatch '<!DOCTYPE html>') {
            $checkReady.Status = "PASS"
        } else {
            $checkReady.Status = "FAIL"
            $checkReady.Hint = "Ready endpoint returned non-200 or HTML SPA fallback; check server log and DB_PATH"
            $allPassed = $false
        }
    } catch {
        $checkReady.Status = "FAIL"
        $checkReady.Hint = "Could not connect to /health/ready: $($_.Exception.Message)"
        $allPassed = $false
    }
    $checks += $checkReady

    # 2. "/" contains real app markers
    $rootUrl = "https://${TargetIp}:${HttpsPort}/"
    $checkRoot = [PSCustomObject]@{ Name = "Root / contains real app markers"; Status = "WAIT"; Hint = "" }
    $mainJsPath = ""
    try {
        $res = Get-HttpsUrl -Url $rootUrl
        if ($res.Headers -match "200" -and ($res.Body -match 'id="root"' -or $res.Body -match 'id="auth-screen"' -or $res.Body -match 'id="app"') -and $res.Body -notmatch 'Waiting for Domain') {
            $checkRoot.Status = "PASS"
            if ($res.Body -match 'src="(/assets/main-[^"]+\.js)"') {
                $mainJsPath = $matches[1]
            } elseif ($res.Body -match 'src="(/assets/[^"]+\.js)"') {
                $mainJsPath = $matches[1]
            }
        } else {
            $checkRoot.Status = "FAIL"
            $checkRoot.Hint = "HTML missing app markers or stuck in waiting-for-domain; check PUBLIC_HOST"
            $allPassed = $false
        }
    } catch {
        $checkRoot.Status = "FAIL"
        $checkRoot.Hint = "Could not connect to /: $($_.Exception.Message)"
        $allPassed = $false
    }
    $checks += $checkRoot

    # 3. Main JS asset loads with JavaScript MIME type
    $checkJs = [PSCustomObject]@{ Name = "Main JS asset loads with JavaScript MIME type"; Status = "WAIT"; Hint = "" }
    if ($mainJsPath -ne "") {
        try {
            $jsUrl = "https://${TargetIp}:${HttpsPort}${mainJsPath}"
            $res = Get-HttpsUrl -Url $jsUrl
            if ($res.Headers -match "200" -and ($res.Headers -match "javascript" -or $res.Headers -match "application/javascript")) {
                $checkJs.Status = "PASS"
            } else {
                $checkJs.Status = "FAIL"
                $checkJs.Hint = "Asset returned non-200 or non-javascript Content-Type"
                $allPassed = $false
            }
        } catch {
            $checkJs.Status = "FAIL"
            $checkJs.Hint = "Failed fetching $($mainJsPath): $($_.Exception.Message)"
            $allPassed = $false
        }
    } else {
        $checkJs.Status = "FAIL"
        $checkJs.Hint = "Could not find main JS bundle path in root HTML"
        $allPassed = $false
    }
    $checks += $checkJs

    # 4. /device-check loads its script
    $checkDc = [PSCustomObject]@{ Name = "/device-check loads its bundled module script"; Status = "WAIT"; Hint = "" }
    try {
        $dcUrl = "https://${TargetIp}:${HttpsPort}/device-check"
        $res = Get-HttpsUrl -Url $dcUrl
        $dcScriptPath = ""
        if ($res.Body -match 'src="(/assets/deviceCheck-[^"]+\.js)"') {
            $dcScriptPath = $matches[1]
        } elseif ($res.Body -match 'src="(/assets/[^"]*deviceCheck[^"]*\.js)"') {
            $dcScriptPath = $matches[1]
        } elseif ($res.Body -match 'src="(/src/[^"]+)"') {
            $checkDc.Status = "FAIL"
            $checkDc.Hint = "Detected development script path '$($matches[1])'; bundled asset required"
            $allPassed = $false
        }

        if ($checkDc.Status -ne "FAIL") {
            if ($dcScriptPath -ne "") {
                $sUrl = "https://${TargetIp}:${HttpsPort}${dcScriptPath}"
                $sRes = Get-HttpsUrl -Url $sUrl
                if ($sRes.Headers -match "200" -and ($sRes.Headers -match "javascript" -or $sRes.Headers -match "application/javascript")) {
                    $checkDc.Status = "PASS"
                } else {
                    $checkDc.Status = "FAIL"
                    $checkDc.Hint = "Script $dcScriptPath returned non-200 or non-javascript Content-Type"
                    $allPassed = $false
                }
            } else {
                $checkDc.Status = "FAIL"
                $checkDc.Hint = "No bundled deviceCheck script reference found in /device-check HTML"
                $allPassed = $false
            }
        }
    } catch {
        $checkDc.Status = "FAIL"
        $checkDc.Hint = "Failed fetching /device-check: $($_.Exception.Message)"
        $allPassed = $false
    }
    $checks += $checkDc

    # 5. Headless browser verification if available
    $nodeCmd = Get-Command "node" -ErrorAction SilentlyContinue
    if ($null -ne $nodeCmd -and (Test-Path "node_modules/@playwright/test")) {
        $checkBrowser = [PSCustomObject]@{ Name = "Headless browser DOM sanity check"; Status = "WAIT"; Hint = "" }
        try {
            $verifyScript = @"
const { chromium } = require('@playwright/test');
(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--ignore-certificate-errors'] });
  const page = await browser.newPage();
  await page.goto('$rootUrl', { waitUntil: 'domcontentloaded', timeout: 8000 });
  const title = await page.title();
  await browser.close();
  if (title.includes('RootInbox')) process.exit(0);
  process.exit(1);
})().catch(() => process.exit(1));
"@
            $tempScript = [System.IO.Path]::GetTempFileName() + ".cjs"
            [System.IO.File]::WriteAllText($tempScript, $verifyScript)
            $p = Start-Process node -ArgumentList $tempScript -NoNewWindow -Wait -PassThru
            Remove-Item $tempScript -Force -ErrorAction SilentlyContinue
            if ($p.ExitCode -eq 0) {
                $checkBrowser.Status = "PASS"
            } else {
                $checkBrowser.Status = "WARN"
                $checkBrowser.Hint = "Headless browser did not verify app title"
            }
        } catch {
            $checkBrowser.Status = "WARN"
            $checkBrowser.Hint = "Playwright invocation error: $($_.Exception.Message)"
        }
        $checks += $checkBrowser
    }

    # Print results
    Write-Host "`n SELF-CHECK RESULTS:" -ForegroundColor Yellow
    foreach ($c in $checks) {
        $color = switch ($c.Status) {
            "PASS" { [System.ConsoleColor]::Green }
            "FAIL" { [System.ConsoleColor]::Red }
            "WARN" { [System.ConsoleColor]::Yellow }
            default { [System.ConsoleColor]::DarkGray }
        }
        Write-Host "  [$($c.Status)] " -ForegroundColor $color -NoNewline
        Write-Host "$($c.Name)" -ForegroundColor White
        if ($c.Hint -ne "") {
            Write-Host "         -> FIX HINT: $($c.Hint)" -ForegroundColor DarkYellow
        }
    }
    Write-Host ""

    if (-not $allPassed) {
        Write-Host "[-] FATAL: Rehearsal self-check failed! One or more essential app shell components are broken." -ForegroundColor Red
        return $false
    }
    Write-Host "[+] All essential rehearsal self-checks PASSED!" -ForegroundColor Green
    return $true
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

# --- 1.1 Handle -InstallCa Switch ---
if ($InstallCa) {
    Write-Banner "RootInbox Windows CA Certificate Installer"
    
    # Locate CA cert
    $caCertPath = Join-Path $DataDir "tls/ca.crt"
    if (-not (Test-Path $caCertPath)) {
        $altPath = "scratch/lan_rehearsal/tls/ca.crt"
        if (Test-Path $altPath) {
            $caCertPath = $altPath
        } else {
            Write-Host "[-] CA certificate not found at '$caCertPath'." -ForegroundColor Red
            Write-Host "    Hint: Run .\scripts\lan-rehearsal.ps1 first to initialize the server and generate the CA certificate." -ForegroundColor Yellow
            exit 1
        }
    }
    $resolvedCaPath = (Resolve-Path $caCertPath).Path

    # Check for elevation (Administrator)
    $isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    if (-not $isAdmin) {
        Write-Host "[!] Administrator privileges are required to install a CA into the Trusted Root store." -ForegroundColor Yellow
        $elevateChoice = Read-Host "Do you want to elevate and run the installation as Administrator? [Y/N] (default: Y)"
        if ($elevateChoice -eq "" -or $elevateChoice -match '^(?i)y(es)?$') {
            $argList = "-ExecutionPolicy Bypass -File `"$PSCommandPath`" -InstallCa -DataDir `"$DataDir`""
            Start-Process powershell -Verb RunAs -ArgumentList $argList -Wait
            return
        } else {
            Write-Host "[-] CA installation aborted by user (elevation declined)." -ForegroundColor Red
            exit 1
        }
    }

    Write-Host "`n[WHY CHROME SAYS 'NOT SECURE']" -ForegroundColor Yellow
    Write-Host "The Windows Certificate Import Wizard defaults to 'Automatically select the certificate store based on the type of certificate'." -ForegroundColor White
    Write-Host "Windows then places the self-signed root into 'Intermediate Certification Authorities'." -ForegroundColor White
    Write-Host "Chrome and Edge require root authorities to reside in 'Trusted Root Certification Authorities' (ROOT)." -ForegroundColor White
    Write-Host "Because of this mismatch, Chrome rejects the CA and reports 'Not secure' (ERR_CERT_AUTHORITY_INVALID).`n" -ForegroundColor White
    Write-Host "To do it manually in the Wizard, select: 'Place all certificates in the following store' -> Browse -> 'Trusted Root Certification Authorities'." -ForegroundColor Cyan
    Write-Host "This script uses certutil to place it directly into the ROOT store.`n" -ForegroundColor Gray

    # Explicit confirmation
    $confirm = Read-Host "Install RootInbox Rehearsal CA ('$resolvedCaPath') into 'Trusted Root Certification Authorities'? [Y/N] (default: Y)"
    if ($confirm -ne "" -and $confirm -notmatch '^(?i)y(es)?$') {
        Write-Host "[-] CA installation cancelled." -ForegroundColor Yellow
        return
    }

    Write-Host "[*] Executing: certutil -addstore -f ROOT `"$resolvedCaPath`"" -ForegroundColor Cyan
    $certutilOut = & certutil -addstore -f ROOT $resolvedCaPath
    $certutilOut | Write-Host -ForegroundColor DarkGray

    # Verification: check store afterwards
    $caBytes = [System.IO.File]::ReadAllBytes($resolvedCaPath)
    $x509 = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new($caBytes)
    $thumbprint = $x509.Thumbprint

    $found = Get-ChildItem -Path Cert:\LocalMachine\Root | Where-Object { $_.Thumbprint -eq $thumbprint }
    if ($found) {
        Write-Host "`n[+] SUCCESS: RootInbox CA ($thumbprint) is verified in 'Trusted Root Certification Authorities'!" -ForegroundColor Green
        Write-Host "    Chrome, Edge, and system WebKit will now trust HTTPS connections to your LAN rehearsal server." -ForegroundColor Green
    } else {
        Write-Host "`n[-] WARNING: certutil ran, but CA thumbprint was not found in Cert:\LocalMachine\Root." -ForegroundColor Red
        exit 1
    }
    return
}

# --- 1.2 Handle -RemoveCa Switch ---
if ($RemoveCa) {
    Write-Banner "RootInbox Windows CA Certificate Remover"
    
    $isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    if (-not $isAdmin) {
        Write-Host "[!] Administrator privileges are required to remove a CA from the Trusted Root store." -ForegroundColor Yellow
        $elevateChoice = Read-Host "Do you want to elevate and run CA removal as Administrator? [Y/N] (default: Y)"
        if ($elevateChoice -eq "" -or $elevateChoice -match '^(?i)y(es)?$') {
            $argList = "-ExecutionPolicy Bypass -File `"$PSCommandPath`" -RemoveCa -DataDir `"$DataDir`""
            Start-Process powershell -Verb RunAs -ArgumentList $argList -Wait
            return
        } else {
            Write-Host "[-] CA removal aborted by user (elevation declined)." -ForegroundColor Red
            exit 1
        }
    }

    # Search for RootInbox certificates in LocalMachine Root
    $targets = Get-ChildItem -Path Cert:\LocalMachine\Root | Where-Object { $_.Subject -match "RootInbox" -or $_.Issuer -match "RootInbox" }
    if (-not $targets -or $targets.Count -eq 0) {
        $caCertPath = Join-Path $DataDir "tls/ca.crt"
        if (Test-Path $caCertPath) {
            $x509 = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new((Resolve-Path $caCertPath).Path)
            $targets = Get-ChildItem -Path Cert:\LocalMachine\Root | Where-Object { $_.Thumbprint -eq $x509.Thumbprint }
        }
    }

    if (-not $targets -or $targets.Count -eq 0) {
        Write-Host "[i] No RootInbox CA certificates found in 'Trusted Root Certification Authorities'." -ForegroundColor Gray
        return
    }

    Write-Host "Found $($targets.Count) RootInbox certificate(s) in Trusted Root store:" -ForegroundColor Yellow
    foreach ($t in $targets) {
        Write-Host "  * Thumbprint: $($t.Thumbprint) | Subject: $($t.Subject) | Expiry: $($t.NotAfter)" -ForegroundColor White
    }

    $confirm = Read-Host "`nAre you sure you want to remove these certificate(s) from Trusted Root store? [Y/N] (default: Y)"
    if ($confirm -ne "" -and $confirm -notmatch '^(?i)y(es)?$') {
        Write-Host "[-] Removal cancelled." -ForegroundColor Yellow
        return
    }

    foreach ($t in $targets) {
        Write-Host "[*] Removing thumbprint $($t.Thumbprint) via certutil..." -ForegroundColor Cyan
        & certutil -delstore ROOT $t.Thumbprint | Out-Null
    }

    # Verify removal
    $remaining = Get-ChildItem -Path Cert:\LocalMachine\Root | Where-Object { $_.Subject -match "RootInbox" }
    if (-not $remaining) {
        Write-Host "[+] SUCCESS: All RootInbox CA certificates have been removed from Trusted Root store." -ForegroundColor Green
    } else {
        Write-Host "[!] Some certificates could not be removed automatically." -ForegroundColor Yellow
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
if ($UseBinary -ne "") {
    if (-not (Test-Path $UseBinary)) {
        Write-Host "[-] Specified binary not found at: '$UseBinary'" -ForegroundColor Red
        exit 1
    }
    $BinarySrc = (Resolve-Path $UseBinary).Path
    Write-Host "[+] Using prebuilt server binary: $BinarySrc (skipping Go and Node compilation)" -ForegroundColor Green
} elseif ((-not (Test-Path $BinarySrc)) -or $ForceRebuild) {
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
    $psi.RedirectStandardOutput = $false
    $psi.RedirectStandardError = $false

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
    $psi.EnvironmentVariables["REHEARSAL_MODE"] = "true"
    $psi.EnvironmentVariables["REHEARSAL_DATA_DIR"] = (Resolve-Path $rehearsalDataDir).Path
    $psi.EnvironmentVariables["REHEARSAL_LOG_FILE"] = Join-Path (Resolve-Path $DataDir).Path "rehearsal.log"

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

# --- 8.5 Run LAN Rehearsal Self-Check ---
$selfCheckOk = Invoke-SelfCheck -TargetIp $selectedIp -HttpsPort $Port -TlsDir $rehearsalTlsDir
if (-not $selfCheckOk) {
    Write-Host "[-] FATAL: Rehearsal self-check failed! Halting rehearsal server." -ForegroundColor Red
    try { Stop-Process -Id $serverProc.Id -Force -ErrorAction SilentlyContinue } catch {}
    if (Test-Path $pidFile) { Remove-Item $pidFile -Force -ErrorAction SilentlyContinue }
    exit 1
}

# --- 9. Display Rehearsal Status Banner ---
Write-Banner "ROOTINBOX LAN REHEARSAL IS READY!"

Write-Host " [STATUS] Server is running in Self-Signed TLS Mode (Process PID: $($serverProc.Id))" -ForegroundColor Green
Write-Host " [READY]  Time to ready: $([math]::Round($sw.ElapsedMilliseconds / 1000.0, 2))s" -ForegroundColor Green
Write-Host ""
Write-Host " NETWORK ACCESS POINTS:" -ForegroundColor Yellow
Write-Host "  * Web Application (HTTPS):     https://${selectedIp}:${Port}" -ForegroundColor Cyan
Write-Host "  * Health Readiness Endpoint:   https://${selectedIp}:${Port}/health/ready" -ForegroundColor White
Write-Host "  * CA Certificate Onboarding:   http://${selectedIp}:${OnboardingPort}" -ForegroundColor Cyan
Write-Host "  * CA Certificate Download:     http://${selectedIp}:${OnboardingPort}/ca.crt" -ForegroundColor White
Write-Host "  * Embedded TURN Relay Server:  ${selectedIp}:${TurnPort} (UDP/TCP)" -ForegroundColor White
Write-Host "  * CA SHA-256 Fingerprint:      $caHash" -ForegroundColor Magenta
Write-Host "  * Rehearsal Access Log:        $(Join-Path (Resolve-Path $DataDir).Path "rehearsal.log")" -ForegroundColor White
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
