@echo off
rem Abre uma URL no navegador padrao SEM janela de console.
rem Uso: abrir-navegador.cmd "http://127.0.0.1:47811/prestart?token=..."
if "%~1"=="" exit /b 1
start "" "%~1"
exit /b 0
