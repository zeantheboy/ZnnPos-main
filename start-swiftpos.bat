@echo off
setlocal EnableDelayedExpansion
color 0B
TITLE ZnnCashier Development Launcher

echo =======================================================
echo          ZnnCashier - Smart Retail Checkout System
echo =======================================================
echo.

:: Check for Node.js
where node >nul 2>nul
if %errorlevel% neq 0 (
    color 0C
    echo [ERROR] Node.js is not installed or not in system PATH!
    echo Please install Node.js from https://nodejs.org/ to run ZnnCashier.
    pause
    exit /b 1
)

echo [INFO] Node.js detected. Checking dependencies...

if not exist "node_modules\" (
    echo [INFO] Installing Root Dependencies...
    call npm install
)

if not exist "frontend\node_modules\" (
    echo [INFO] Installing Frontend Dependencies...
    cd frontend
    call npm install
    cd ..
)

echo.
color 0A
echo =======================================================
echo   Starting Backend, Frontend, and Desktop Application
echo =======================================================
echo.
echo [INFO] To connect your mobile phone as a barcode scanner,
echo        click "Connect Mobile Scanner" in the app.
echo.
echo [WARNING] Keep this window open. Closing it will terminate the app!
echo.

cmd /c "npm start"

echo.
color 0E
    echo [INFO] ZnnCashier has been closed.
pause
