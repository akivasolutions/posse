@echo off
REM Bullpen for Windows. Double-click to start; your browser opens, signed in.
REM If Node.js isn't installed, this offers to download it (about 30 MB, just for your account,
REM no admin rights needed). update.cmd runs this with --update.
setlocal
cd /d "%~dp0"
set "SCRIPT=server.js"
if /i "%~1"=="--update" set "SCRIPT=update.js"
call :findnode
if not defined NODE call :getnode
if not defined NODE goto :nonode
REM Keep this on one line: Windows has then read all of it before an update replaces this file.
"%NODE%" "%~dp0%SCRIPT%" --open & echo. & pause & exit /b

:nonode
echo.
echo   Bullpen needs Node.js 18.17 or newer. Install the LTS version from https://nodejs.org
echo   or ask your IT team, then run this again.
echo.
pause
exit /b 1

:findnode
set "NODE="
for /f "delims=" %%i in ('where node 2^>nul') do if not defined NODE call :trynode "%%i"
if not defined NODE if exist "%LOCALAPPDATA%\Bullpen\node\node.exe" call :trynode "%LOCALAPPDATA%\Bullpen\node\node.exe"
exit /b

:trynode
"%~1" -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>18||(a===18&&b>=17)?0:1)" >nul 2>nul && set "NODE=%~1"
exit /b

:getnode
set "NB=%LOCALAPPDATA%\Bullpen"
echo.
echo   Bullpen needs Node.js, and this computer doesn't have it (or has an old one).
echo   It can download the official Node.js from nodejs.org (about 30 MB) into
echo   %NB%\node, just for your account. No admin rights needed.
echo.
set "ANS="
set /p "ANS=  Download it now? [Y/n] "
if /i "%ANS%"=="n" exit /b
if /i "%ANS%"=="no" exit /b
set "TMPD=%NB%\download"
set "ARCH=x64"
if /i "%PROCESSOR_ARCHITECTURE%"=="ARM64" set "ARCH=arm64"
if /i "%PROCESSOR_ARCHITEW6432%"=="ARM64" set "ARCH=arm64"
set "DIST=https://nodejs.org/dist/latest-v24.x"
if exist "%TMPD%" rmdir /s /q "%TMPD%"
mkdir "%TMPD%" || goto :nodefail
curl.exe -fsSL "%DIST%/SHASUMS256.txt" -o "%TMPD%\SHASUMS256.txt" || goto :nodefail
set "SUM="
set "ZIP="
for /f "tokens=1,2" %%a in ('findstr /c:"-win-%ARCH%.zip" "%TMPD%\SHASUMS256.txt"') do (set "SUM=%%a" & set "ZIP=%%b")
if not defined ZIP goto :nodefail
echo   Downloading %ZIP% ...
curl.exe -fL --progress-bar "%DIST%/%ZIP%" -o "%TMPD%\%ZIP%" || goto :nodefail
set "GOT="
for /f "skip=1 delims=" %%h in ('certutil -hashfile "%TMPD%\%ZIP%" SHA256') do if not defined GOT set "GOT=%%h"
if not defined GOT goto :nodefail
set "GOT=%GOT: =%"
if /i not "%GOT%"=="%SUM%" goto :badsum
echo   Unpacking ...
tar -xf "%TMPD%\%ZIP%" -C "%TMPD%" || goto :nodefail
if exist "%NB%\node" rmdir /s /q "%NB%\node"
move "%TMPD%\%ZIP:~0,-4%" "%NB%\node" >nul || goto :nodefail
rmdir /s /q "%TMPD%"
call :trynode "%NB%\node\node.exe"
if defined NODE echo   Node.js is ready.
exit /b

:badsum
echo.
echo   The download didn't match nodejs.org's checksum, so it was not used.
rmdir /s /q "%TMPD%" 2>nul
exit /b

:nodefail
echo.
echo   Couldn't download Node.js automatically. A work network may block it.
rmdir /s /q "%TMPD%" 2>nul
exit /b
