@echo off
title RootInbox - Configure Windows Firewall for LAN Access
cd /d "%~dp0"

net session >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo ====================================================================
    echo  Requesting Administrator privileges to configure Windows Firewall...
    echo  Please click "Yes" on the Windows prompt.
    echo ====================================================================
    powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process cmd -ArgumentList '/c \"\"%~f0\"\" admin' -Verb RunAs"
    exit /b
)

echo ====================================================================
echo  Configuring Windows Firewall for RootInbox...
echo ====================================================================
echo.

:: 1. Allow TCP Port 8080 Inbound
netsh advfirewall firewall delete rule name="RootInbox Messenger Port 8080" >nul 2>&1
netsh advfirewall firewall add rule name="RootInbox Messenger Port 8080" dir=in action=allow protocol=TCP localport=8080 profile=any >nul
echo [OK] Inbound TCP port 8080 allowed in Windows Firewall.

:: 2. Allow rootinbox.exe program
if exist "%~dp0rootinbox.exe" (
    netsh advfirewall firewall delete rule name="RootInbox Program" >nul 2>&1
    netsh advfirewall firewall add rule name="RootInbox Program" dir=in action=allow program="%~dp0rootinbox.exe" enable=yes profile=any >nul
    echo [OK] Program rule added for rootinbox.exe.
)

:: 3. Change Wi-Fi to Private Network (Allows local LAN communication)
powershell -NoProfile -Command "Get-NetConnectionProfile -InterfaceAlias 'Wi-Fi' -ErrorAction SilentlyContinue | Set-NetConnectionProfile -NetworkCategory Private -ErrorAction SilentlyContinue" >nul 2>&1
echo [OK] Wi-Fi network profile set to Private (allows local sharing).

:: Get Wi-Fi IP
set LOCAL_IP=
for /f "tokens=*" %%a in ('powershell -NoProfile -Command "(Get-NetIPAddress -InterfaceAlias 'Wi-Fi' -AddressFamily IPv4 -ErrorAction SilentlyContinue).IPAddress"') do (
    if not defined LOCAL_IP set LOCAL_IP=%%a
)
if not defined LOCAL_IP set LOCAL_IP=10.19.70.139

echo.
echo ====================================================================
echo  FIREWALL CONFIGURED SUCCESSFULLY!
echo.
echo  You can now open RootInbox on your phone at:
echo    http://%LOCAL_IP%:8080
echo ====================================================================
echo.
echo Press any key to close this window...
pause >nul
