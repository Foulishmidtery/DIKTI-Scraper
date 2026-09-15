@echo off
setlocal
cd /d "%~dp0"

echo ============================================================
echo KNEKS PDDIKTI - Clean UI V3
echo Official Magic UI + Aceternity + React Bits components
echo NO 21st.dev login required
echo ============================================================
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\install-original-ui.ps1"
if errorlevel 1 (
  echo.
  echo INSTALLATION FAILED. Read the error above.
  pause
  exit /b 1
)

echo.
echo Starting Vite...
npm run dev
