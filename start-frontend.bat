@echo off
setlocal
cd /d "%~dp0frontend"
call npm install
call npm run dev
