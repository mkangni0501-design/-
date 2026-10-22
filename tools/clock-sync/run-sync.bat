@echo off
chcp 65001 >nul
cd /d "%~dp0"
node sync-clock.mjs %*
set RC=%ERRORLEVEL%
if /i not "%~1"=="--scheduled" (
  echo.
  if %RC%==0 (echo 同步完成，詳細請看 sync.log) else (echo 同步失敗，詳細請看 sync.log)
  pause
)
exit /b %RC%
