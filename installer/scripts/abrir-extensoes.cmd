@echo off
rem ==========================================================================
rem  Abre a pagina de extensoes do navegador, com o painel do Marketplace
rem  Intelligence ja aberto na tela de Pre-Start.
rem
rem  Por que um .cmd e nao um link direto:
rem    -Uma pagina "edge://extensions" nao pode ser aberta por link http, e
rem    -"start edge://extensions" faz o Windows procurar um site chamado "edge"
rem     (DNS_PROBE_FINISHED_NXDOMAIN).
rem  A saida e chamar o navegador com --extensions-url, que so um processo pode
rem  fazer. Nada de janela preta: este arquivo roda com "start /min" e fecha.
rem
rem  Uso: abrir-extensoes.cmd "http://127.0.0.1:47811/?token=..."
rem ==========================================================================
setlocal enableextensions
set "PANEL=%~1"
set "URL=--extensions-url"

set "CHROME="
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" set "CHROME=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not defined CHROME if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" set "CHROME=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if not defined CHROME if exist "%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe" set "CHROME=%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"

set "EDGE="
if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" set "EDGE=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if not defined EDGE if exist "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" set "EDGE=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"

if defined CHROME (
  if defined PANEL (
    start "" "%CHROME%" %URL% "%PANEL%"
  ) else (
    start "" "%CHROME%" %URL%
  )
  exit /b 0
)

if defined EDGE (
  if defined PANEL (
    start "" "%EDGE%" %URL% "%PANEL%"
  ) else (
    start "" "%EDGE%" %URL%
  )
  exit /b 0
)

rem Nenhum navegador conhecido: abre a pagina do painel, que explica o passo.
if defined PANEL start "" "%PANEL%"
exit /b 1
