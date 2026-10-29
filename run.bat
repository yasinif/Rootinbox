@echo off
title RootInbox Messenger Server
cd /d "%~dp0"

echo ====================================================================
echo                 RootInbox Zero-Knowledge Messenger
echo ====================================================================
echo Starting server...

:: Set Environment Variables
set INSECURE_DEV_MODE=true
set APP_ORIGIN=http://localhost:8080
set SERVER_HOST=0.0.0.0
set SERVER_PORT=8080
set IP_HASH_SECRET=dev-secret-key-that-is-at-least-32-bytes-long!!
set PUSH_ENABLED=false
set TURN_ENABLED=false

:: Detect local IP address on Wi-Fi or Ethernet
set LOCAL_IP=
for /f "tokens=*" %%a in ('powershell -NoProfile -Command "(Get-NetIPAddress -InterfaceAlias 'Wi-Fi' -AddressFamily IPv4 -ErrorAction SilentlyContinue).IPAddress"') do (
    if not defined LOCAL_IP set LOCAL_IP=%%a
)
if not defined LOCAL_IP (
    for /f "tokens=*" %%a in ('powershell -NoProfile -Command "(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -notmatch '^(169\.254|127\.|172\.18)' } | Select-Object -ExpandProperty IPAddress -First 1)"') do (
        if not defined LOCAL_IP set LOCAL_IP=%%a
    )
)
if not defined LOCAL_IP set LOCAL_IP=127.0.0.1

echo.
echo ====================================================================
echo  [SERVER READY]
echo.
echo  * Local access (this PC):
echo      http://localhost:8080
echo.
echo  * Mobile & other devices on this Wi-Fi:
echo      http://%LOCAL_IP%:8080
echo.
echo  Registration, Login, Chat, and File Sending work directly on mobile!
echo.
echo  (Optional - for voice/video calls microphone access on mobile Chrome):
echo    In mobile Chrome: open chrome://flags
echo    Search: Insecure origins treated as secure
echo    Add: http://%LOCAL_IP%:8080
echo    Enable and Relaunch Chrome.
echo ====================================================================
echo.

:: Open default browser after 2 seconds
start "" cmd /c "timeout /t 2 /nobreak >nul & start http://localhost:8080"

:: Launch executable if compiled, otherwise go run
if exist "rootinbox.exe" (
    rootinbox.exe
) else (
    echo Building and starting RootInbox via Go...
    go run ./cmd/rootinbox
)

if %ERRORLEVEL% neq 0 (
    echo.
    echo Server stopped with an error. Press any key to exit.
    pause >nul
)
