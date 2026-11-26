@echo off
setlocal enabledelayedexpansion
set "APP=%~dp0"
set "MI_DATA_DIR=%LOCALAPPDATA%\MarketplaceIntelligence"
set "EXT_DIR=%APP%extension"
set "ID_FILE=%MI_DATA_DIR%\extension-id.txt"
set "NODE=%APP%node.exe"

echo.
echo  Extensao do Marketplace Intelligence
echo  -----------------------------------
if not exist "%EXT_DIR%\manifest.json" (
  echo  ERRO: a pasta da extensao nao foi encontrada em:
  echo    %EXT_DIR%
  pause
  exit /b 1
)

rem 1) ID fixo da extensao (vem da chave publica no manifest) e registro do host.
if not exist "%MI_DATA_DIR%" mkdir "%MI_DATA_DIR%"
if not exist "%ID_FILE%" echo iindgpgiecidhmfapdlfinpplndiiajf>"%ID_FILE%"
"%NODE%" "%APP%native-host\register.js" --extension-id=iindgpgiecidhmfapdlfinpplndiiajf
if errorlevel 1 (
  echo  AVISO: o registro do host nativo falhou. A extensao ainda pode ser usada
  echo         pelo modo HTTP local.
) else (
  echo  Host nativo registrado para Chrome e Edge.
)

rem 2) Copia o caminho da pasta para a area de transferencia.
echo %EXT_DIR%| clip
echo.
echo  Passo a passo:
echo   1. O navegador vai abrir na pagina de extensoes.
echo      Se nao abrir, cole na barra de enderecos:  chrome://extensions
echo      (no Edge:  edge://extensions )
echo   2. Ative o "Modo do desenvolvedor" (canto superior direito).
echo   3. Clique em "Carregar sem compactacao" e cole o caminho abaixo.
echo      O caminho ja esta na area de transferencia: use Ctrl+V.
echo.
echo      %EXT_DIR%
echo.
echo   O ID da extensao deve ser: iindgpgiecidhmfapdlfinpplndiiajf
echo.

rem 3) Abre a pasta da extensao no Explorador e a pagina de extensoes no navegador.
rem    Usa abrir-extensoes.cmd: "start chrome://..." faz o Windows procurar o site
rem    "chrome" e dar DNS_PROBE_FINISHED_NXDOMAIN.
start "" "%EXT_DIR%"
call "%APP%abrir-extensoes.cmd"

echo  Abrindo as paginas de extensao...
pause
endlocal
