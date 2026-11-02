# ==============================================================================
# RootInbox LAN Rehearsal Verification Probe (PowerShell)
# Verifies HTTPS, HTTP Onboarding, and TURN Relay connectivity on LAN IP
# ==============================================================================

[CmdletBinding()]
param(
    [string]$LanIp = "127.0.0.1",
    [int]$Port = 8443,
    [int]$OnboardingPort = 8080,
    [int]$TurnPort = 3478,
    [int]$TimeoutSec = 5
)

$ErrorActionPreference = "Stop"

Write-Host "================================================================================" -ForegroundColor Cyan
Write-Host " RootInbox LAN Rehearsal Connectivity & Verification Probe" -ForegroundColor Cyan
Write-Host " Target Host: $LanIp" -ForegroundColor Cyan
Write-Host "================================================================================" -ForegroundColor Cyan

$passed = 0
$failed = 0

function Test-Probe {
    param(
        [string]$Name,
        [scriptblock]$Action
    )
    Write-Host "[*] Probing: $Name... " -NoNewline
    try {
        $result = & $Action
        Write-Host "PASS" -ForegroundColor Green
        if ($result) {
            Write-Host "    Details: $result" -ForegroundColor DarkGray
        }
        $script:passed++
    } catch {
        Write-Host "FAIL" -ForegroundColor Red
        Write-Host "    Error: $($_.Exception.Message)" -ForegroundColor Red
        $script:failed++
    }
}

# 1. Probe HTTP Onboarding CA Certificate
Test-Probe -Name "HTTP Onboarding CA Certificate (http://${LanIp}:${OnboardingPort}/ca.crt)" -Action {
    $uri = "http://${LanIp}:${OnboardingPort}/ca.crt"
    $res = Invoke-WebRequest -Uri $uri -TimeoutSec $TimeoutSec -UseBasicParsing -ErrorAction Stop
    if ($res.StatusCode -ne 200) {
        throw "Unexpected HTTP status: $($res.StatusCode)"
    }
    if ($res.Content.Length -lt 100) {
        throw "CA certificate content suspiciously small ($($res.Content.Length) bytes)"
    }
    return "$($res.StatusCode) OK, $($res.Content.Length) bytes received"
}

# 2. Probe HTTP Onboarding Guide HTML Page
Test-Probe -Name "HTTP Onboarding Guide Page (http://${LanIp}:${OnboardingPort}/)" -Action {
    $uri = "http://${LanIp}:${OnboardingPort}/"
    $res = Invoke-WebRequest -Uri $uri -TimeoutSec $TimeoutSec -UseBasicParsing -ErrorAction Stop
    if ($res.StatusCode -ne 200) {
        throw "Unexpected HTTP status: $($res.StatusCode)"
    }
    if ($res.Content -notmatch "RootInbox") {
        throw "Page content does not contain 'RootInbox'"
    }
    return "$($res.StatusCode) OK, HTML title verified"
}

[System.Net.ServicePointManager]::SecurityProtocol = [System.Net.SecurityProtocolType]::Tls12

# 3. Probe HTTPS Health Check (/healthz) with Self-Signed Certificate
Test-Probe -Name "HTTPS Health Check (https://${LanIp}:${Port}/healthz)" -Action {
    if (Get-Command curl.exe -ErrorAction SilentlyContinue) {
        $code = & curl.exe -k -s -w "%{http_code}" -o NUL --connect-timeout $TimeoutSec "https://${LanIp}:${Port}/healthz"
        if ($code -ne "200") {
            throw "Unexpected HTTP status: $code"
        }
        return "HTTP $code OK (verified via curl)"
    } else {
        $uri = "https://${LanIp}:${Port}/healthz"
        $originalCallback = [System.Net.ServicePointManager]::ServerCertificateValidationCallback
        try {
            [System.Net.ServicePointManager]::ServerCertificateValidationCallback = { $true }
            $res = Invoke-WebRequest -Uri $uri -TimeoutSec $TimeoutSec -UseBasicParsing -ErrorAction Stop
            if ($res.StatusCode -ne 200) {
                throw "Unexpected status code $($res.StatusCode)"
            }
            return "$($res.StatusCode) OK, Payload: $(($res.Content | Out-String).Trim())"
        } finally {
            [System.Net.ServicePointManager]::ServerCertificateValidationCallback = $originalCallback
        }
    }
}

# 4. Probe HTTPS Main Application Entry Point
Test-Probe -Name "HTTPS Web Application Shell (https://${LanIp}:${Port}/)" -Action {
    if (Get-Command curl.exe -ErrorAction SilentlyContinue) {
        $code = & curl.exe -k -s -w "%{http_code}" -o NUL --connect-timeout $TimeoutSec "https://${LanIp}:${Port}/"
        if ($code -ne "200") {
            throw "Unexpected HTTP status: $code"
        }
        return "HTTP $code OK (verified via curl)"
    } else {
        $uri = "https://${LanIp}:${Port}/"
        $originalCallback = [System.Net.ServicePointManager]::ServerCertificateValidationCallback
        try {
            [System.Net.ServicePointManager]::ServerCertificateValidationCallback = { $true }
            $res = Invoke-WebRequest -Uri $uri -TimeoutSec $TimeoutSec -UseBasicParsing -ErrorAction Stop
            if ($res.StatusCode -ne 200) {
                throw "Unexpected status code $($res.StatusCode)"
            }
            return "$($res.StatusCode) OK, HTML Content-Length: $($res.Content.Length)"
        } finally {
            [System.Net.ServicePointManager]::ServerCertificateValidationCallback = $originalCallback
        }
    }
}

# 5. Probe TURN / STUN Server (UDP Packet Test)
Test-Probe -Name "TURN Relay Server UDP Port (${LanIp}:${TurnPort})" -Action {
    $udp = [System.Net.Sockets.UdpClient]::new()
    $udp.Client.ReceiveTimeout = [int]($TimeoutSec * 1000)
    try {
        # RFC-5389 STUN Binding Request (20 bytes: 0x0001, 0x0000, 0x2112A442 magic cookie, 12-byte transaction ID)
        $stunReq = [byte[]](0x00, 0x01, 0x00, 0x00, 0x21, 0x12, 0xA4, 0x42, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0A, 0x0B, 0x0C)
        [void]$udp.Send($stunReq, $stunReq.Length, $LanIp, $TurnPort)
        $remoteEp = [System.Net.IPEndPoint]::new([System.Net.IPAddress]::Any, 0)
        $resp = $udp.Receive([ref]$remoteEp)
        if ($resp.Length -lt 20) {
            throw "STUN response too short ($($resp.Length) bytes)"
        }
        $msgType = ([int]$resp[0] * 256) + [int]$resp[1]
        if ($msgType -ne 0x0101) {
            throw ("Unexpected STUN message type: 0x{0:X4} (expected 0x0101 Binding Success)" -f $msgType)
        }
        return "STUN Binding Success (0x0101) from $($remoteEp.ToString()) ($($resp.Length) bytes)"
    } finally {
        $udp.Close()
    }
}

Write-Host "--------------------------------------------------------------------------------" -ForegroundColor Gray
Write-Host " Probe Summary: $passed Passed, $failed Failed" -ForegroundColor $(if ($failed -eq 0) { "Green" } else { "Red" })
Write-Host "================================================================================" -ForegroundColor Cyan

if ($failed -gt 0) {
    throw "LAN rehearsal check probe failed: $failed probe(s) failed."
}
return
