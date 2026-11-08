@echo off
color 0B
echo =======================================================
echo          ZnnCashier - Firewall Configuration
echo =======================================================
echo.
echo Checking for Administrator privileges...
net session >nul 2>&1
if %errorLevel% neq 0 (
    color 0C
    echo [ERROR] You must run this script as Administrator.
    echo Please right-click 'fix-firewall.bat' and select "Run as administrator".
    pause
    exit /b 1
)

echo [INFO] Adding Firewall Rules for ZnnCashier (Ports 3001, 3002)...
netsh advfirewall firewall add rule name="ZnnCashier Backend" dir=in action=allow protocol=TCP localport=3001-3002 >nul
if %errorLevel% equ 0 (
    color 0A
    echo.
    echo [SUCCESS] Firewall rules added successfully! 
echo Your mobile phone should now be able to connect to the ZnnCashier scanner.
) else (
    color 0C
    echo.
    echo [ERROR] Failed to add firewall rules.
)
echo.
pause
