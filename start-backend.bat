@echo off
setlocal
cd /d "%~dp0"
if not exist ".env" copy ".env.example" ".env" >nul
py -3 -m pip install -r backend\requirements.txt --quiet
py -3 -m backend.app
