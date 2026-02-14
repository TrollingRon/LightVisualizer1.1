@echo off
setlocal
cd /d "%~dp0"

call npm run build:win
if errorlevel 1 (
  echo.
  echo Build failed.
  exit /b %errorlevel%
)

echo.
echo Build complete. Opening release folder...
start "" "%cd%\release"

