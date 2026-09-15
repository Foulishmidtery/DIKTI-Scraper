@echo off
setlocal
cd /d "%~dp0"
start "PDDIKTI API" cmd /k call start-backend.bat
start "PDDIKTI Frontend" cmd /k call start-frontend.bat
