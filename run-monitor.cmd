@echo off
REM Pokémon Restock Monitor — lanzador para la tarea programada de Windows.
REM Corre UNA pasada del monitor desde la carpeta del proyecto (sin rutas absolutas,
REM así este archivo sí se puede commitear). Log diario en logs\monitor-YYYY-MM-DD.log.
setlocal
cd /d "%~dp0"

REM Confía en el almacén de certificados de Windows (proxy TLS local, p. ej. Avast).
set "NODE_OPTIONS=--use-system-ca"
set "RUNNER_ID=pc"
set "SEND_DISCORD=true"
set "LOG_PRETTY=false"

set "NODE_EXE=node"
if exist "C:\Program Files\nodejs\node.exe" set "NODE_EXE=C:\Program Files\nodejs\node.exe"

if not exist logs mkdir logs
for /f %%i in ('powershell -NoProfile -Command "Get-Date -Format yyyy-MM-dd"') do set "TODAY=%%i"
if "%TODAY%"=="" set "TODAY=unknown"

"%NODE_EXE%" "src\jobs\runRestockMonitor.js" >> "logs\monitor-%TODAY%.log" 2>&1

REM Rotación: borra logs de más de 14 días.
forfiles /p logs /m *.log /d -14 /c "cmd /c del @path" >nul 2>&1
endlocal
