@echo off
:: Doble clic: pide permiso de administrador y lanza la captura.
:: Arrastra la CARPETA del firmware sobre este .bat, o escribela cuando la pida.
set "FW=%~1"
if "%FW%"=="" set /p "FW=Carpeta del firmware: "
powershell -NoProfile -Command "Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile -ExecutionPolicy Bypass -NoExit -File \"%~dp0captura_odin.ps1\" -Carpeta \"%FW%\"'"
