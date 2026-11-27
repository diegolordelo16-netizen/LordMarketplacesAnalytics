@echo off
rem ==========================================================================
rem  Marketplace Intelligence — launcher silencioso
rem
rem  Uso:
rem    start-panel.cmd              abre o painel (ou a tela de Pre-Start, se
rem                                 for a primeira vez)
rem    start-panel.cmd --prestart   abre direto a tela de Pre-Start
rem    start-panel.cmd --background sobe o servico em segundo plano, sem abrir
rem                                 nada (usado no inicio com o Windows)
rem
rem  Sempre sem janela de console: o servico roda com node.exe (nao node.cmd)
rem  e a saida vai para arquivos de log no %LOCALAPPDATA%.
rem ==========================================================================
setlocal enableextensions
set "APP=%~dp0"
set "DATA=%LOCALAPPDATA%\MarketplaceIntelligence"
set "NODE=%APP%node.exe"
set "MAIN=%APP%local-agent\main.js"
set "PORTFILE=%DATA%\port.txt"
set "URLFILE=%DATA%\panel-url.txt"
set "LOG=%DATA%\logs\service.log"
set "ERR=%DATA%\logs\service-err.log"

if not exist "%DATA%" mkdir "%DATA%"
if not exist "%DATA%\logs" mkdir "%DATA%\logs"
if exist "%DATA%\update-in-progress.json" exit /b 1

set "MODE=panel"
if /i "%~1"=="--prestart" set "MODE=prestart"
if /i "%~1"=="--background" set "MODE=background"

rem ---------------------------------------------------------------- ja rodando?
rem A URL fica em panel-url.txt e so e reaproveitada se /api/health responder.
set "URL="
if exist "%URLFILE%" (
  rem copia para um nome curto ao lado do script: o cmd deste Windows falha
  rem quando o caminho mistura "C:/..." com "\...".
  copy /y "%URLFILE%" "%APP%panel-url.tmp" >nul 2>&1
  if exist "%APP%panel-url.tmp" (
    for /f "usebackq delims=" %%L in ("%APP%panel-url.tmp") do set "URL=%%L"
    del "%APP%panel-url.tmp%" >nul 2>&1
  )
)
if defined URL (
  curl -s -o NUL --max-time 2 "%URL%api/health" 2>nul && (
    if "%MODE%"=="background" exit /b 0
    if "%MODE%"=="prestart" (
      start "" "%URL%prestart"
    ) else (
      start "" "%URL%"
    )
    exit /b 0
  )
)

rem ---------------------------------------------------------------- subir o servico
set "PORT="
if exist "%PORTFILE%" (
  copy /y "%PORTFILE%" "%APP%port.tmp" >nul 2>&1
  if exist "%APP%port.tmp" (
    for /f "usebackq delims=" %%P in ("%APP%port.tmp") do set "PORT=%%P"
    del "%APP%port.tmp%" >nul 2>&1
  )
)
if not defined PORT set "PORT=47811"

if "%MODE%"=="background" (
  start "" /b "%NODE%" "%MAIN%" --serve --port=%PORT% --data="%DATA%" >>"%LOG%" 2>>"%ERR%"
) else (
  start "" /min "%NODE%" "%MAIN%" --serve --port=%PORT% --data="%DATA%" >>"%LOG%" 2>>"%ERR%"
)

rem ---------------------------------------------------------------- esperar a URL
set "TARGET="
set /a TRIES=0
:wait
set /a TRIES+=1
if exist "%URLFILE%" (
  copy /y "%URLFILE%" "%APP%panel-url.tmp" >nul 2>&1
  if exist "%APP%panel-url.tmp" (
    for /f "usebackq delims=" %%L in ("%APP%panel-url.tmp") do set "TARGET=%%L"
    del "%APP%panel-url.tmp%" >nul 2>&1
  )
)
if defined TARGET goto open
if %TRIES% GEQ 40 goto fail
ping -n 2 127.0.0.1 >nul
goto wait

:open
if "%MODE%"=="background" exit /b 0
if "%MODE%"=="prestart" (
  start "" "%TARGET%prestart"
) else (
  start "" "%TARGET%"
)
exit /b 0

:fail
if "%MODE%"=="background" exit /b 1
echo.
echo  O servico local nao respondeu. Veja o log:
echo    %ERR%
echo.
pause
exit /b 1
