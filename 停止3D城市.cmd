@echo off
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":5178" ^| findstr "LISTENING"') do taskkill /PID %%a /F >nul 2>nul
echo 3D城市本机服务已停止。
timeout /t 2 >nul
