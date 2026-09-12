@echo off
cd /d "%~dp0"
node --preserve-symlinks-main "%~dp0launch.cjs"
