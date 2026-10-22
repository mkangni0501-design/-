@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 即將建立 Windows 排程工作：每天 21:30 自動執行打卡同步（打卡機下班打卡都結束後）
schtasks /create /tn "校務系統打卡同步" /tr "\"%~dp0run-sync.bat\" --scheduled" /sc daily /st 21:30 /f
if errorlevel 1 (
  echo.
  echo 建立失敗，請對這個檔案按右鍵 → 以系統管理員身分執行
) else (
  echo.
  echo 已建立。可以到「工作排程器」找到「校務系統打卡同步」，在「設定」分頁勾選「如果錯過排定的開始時間，儘快執行工作」。
)
pause
