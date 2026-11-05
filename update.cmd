@echo off
REM Updates Bullpen to the latest version, then starts it. Your bots, chats and settings are kept.
call "%~dp0start.cmd" --update & exit /b
