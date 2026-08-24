@echo off
echo Starting Face Detection Service...
cd /d "%~dp0"
"C:\Users\blesDev\Documents\project\HumanDetectionPrototype\raspberry-pi-4b\venv\Scripts\python.exe" face_service.py
pause
