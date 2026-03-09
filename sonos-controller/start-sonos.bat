@echo off
cd /d "C:\sonos-online\backend"
"C:\Program Files\nodejs\node.exe" server.js > "C:\sonos-online\sonos.log" 2>&1
