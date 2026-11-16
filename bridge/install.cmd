@echo off
chcp 65001 >nul
rem מתקין את התוכנה של Pulse למחשב: מעתיק אותה ל-%LOCALAPPDATA%\OfflinePlayer-Bridge
rem ומוסיף אותה להפעלה האוטומטית של Windows (רצה ברקע, בלי חלון).
set "DEST=%LOCALAPPDATA%\OfflinePlayer-Bridge"
set "SRC=%~dp0"
if not exist "%SRC%agent.js" (
  echo.
  echo לא נמצאו קבצי התוכנה. לחצו לחיצה ימנית על Pulse-PC.zip, בחרו "חלץ הכל",
  echo ואז הריצו את install.cmd מהתיקייה שנוצרה.
  pause
  exit /b 1
)
rem עדכון: עוצרים את הגרסה שכבר רצה ברקע, כדי שלא ירוצו שתיים
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { ($_.Name -eq 'node.exe' -and $_.CommandLine -like '*agent.js*' -and $_.CommandLine -like '*OFFLIN*') -or ($_.Name -eq 'node.exe' -and $_.CommandLine -like '*OfflinePlayer-Bridge*') -or ($_.Name -eq 'powershell.exe' -and $_.CommandLine -like '*OfflinePlayer-Bridge*mtp.ps1*') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }" >nul 2>&1
mkdir "%DEST%\lib" 2>nul
mkdir "%DEST%\ps" 2>nul
copy /y "%SRC%agent.js" "%DEST%\" >nul || (echo לא הצלחתי להעתיק את agent.js & pause & exit /b 1)
copy /y "%SRC%lib\*.js" "%DEST%\lib\" >nul || (echo לא הצלחתי להעתיק את lib & pause & exit /b 1)
copy /y "%SRC%ps\mtp.ps1" "%DEST%\ps\" >nul || (echo לא הצלחתי להעתיק את mtp.ps1 & pause & exit /b 1)
for /f "delims=" %%n in ('where node 2^>nul') do set "NODE=%%n" & goto found
rem אין Node.js — מתקינים אותו (התוכנה כתובה ב-Node)
echo מתקין Node.js...
rem --source winget: בלי חנות מיקרוסופט, שנכשלת מאחורי סינון (NetFree)
winget install -e --id OpenJS.NodeJS.LTS --source winget --accept-source-agreements --accept-package-agreements
set "NODE=%ProgramFiles%\nodejs\node.exe"
if exist "%NODE%" goto found
echo מוריד את Node.js...
curl.exe -sfL -o "%DEST%\node.exe" https://nodejs.org/dist/v22.12.0/win-x64/node.exe
set "NODE=%DEST%\node.exe"
if not exist "%NODE%" echo לא הצלחתי להתקין את Node.js. התקינו אותו מ-nodejs.org והריצו שוב. & pause & exit /b 1
:found
rem בקובץ ה-VBS רק נתיבים קצרים (באנגלית) — הוא לא קורא עברית
for %%i in ("%DEST%\agent.js") do set "SAGENT=%%~si"
for %%i in ("%NODE%") do set "SNODE=%%~si"
set "STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
del "%STARTUP%\OfflinePlayer-Bridge.lnk" >nul 2>&1
del "%STARTUP%\OfflinePlayer-Bridge.vbs" >nul 2>&1
set "VBS=%STARTUP%\Pulse-PC.vbs"
> "%VBS%" echo CreateObject("WScript.Shell").Run """%SNODE%"" ""%SAGENT%""", 0, False
wscript "%VBS%"
echo.
echo הותקן. התוכנה רצה עכשיו ברקע, ותופעל אוטומטית בכל הפעלה של המחשב.
echo חברו את הנגן בכבל USB ופתחו בו את Pulse.
timeout /t 6 >nul
