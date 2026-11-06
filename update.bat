@echo off
rem Mee Terminal - update: git pull + pip (only if requirements changed) + pm2 restart (only if server files changed)
rem Double-click this file on the VPS. (pm2 is a .cmd -> must use call, otherwise the script stops after it)
setlocal
cd /d "%~dp0"

for /f %%i in ('git rev-parse HEAD') do set OLD=%%i
echo === git pull ===
git pull
if errorlevel 1 (
  echo.
  echo [ERROR] git pull failed - see message above
  pause
  exit /b 1
)
for /f %%i in ('git rev-parse HEAD') do set NEW=%%i
if "%OLD%"=="%NEW%" (
  echo.
  echo Already up to date - nothing to do.
  pause
  exit /b 0
)

echo.
echo === changed files ===
git diff --name-only %OLD% %NEW% -- .

git diff --name-only %OLD% %NEW% -- requirements.txt | findstr . >nul
if not errorlevel 1 (
  echo.
  echo === pip install ===
  venv\Scripts\pip.exe install -r requirements.txt
)

rem web-only change (static / docs / tests / .md) = refresh the browser, no restart needed
git diff --name-only %OLD% %NEW% -- . | findstr /V /R /C:"^static/" /C:"^docs/" /C:"^tests/" /C:"\.md$" >nul
if errorlevel 1 (
  echo.
  echo Web page only - just refresh the browser. No restart needed.
) else (
  echo.
  echo === pm2 restart ===
  call pm2 startOrRestart ecosystem.config.js --update-env
  call pm2 save
  call pm2 ls
)
echo.
echo Done.
pause
