@echo off
set "ORBYTE_NODE_VERSION=24.22.1"
set "ORBYTE_PNPM_VERSION=12.16.0"

where fnm >nul 2>nul
if errorlevel 1 (
	where winget >nul 2>nul
	if errorlevel 1 (
		echo [Orbyte] Neither fnm nor winget was found on PATH.
		echo [Orbyte] Install fnm from https://github.com/Schniz/fnm#installation
		echo [Orbyte] Then open a new Command Prompt and run this script again.
		exit /b 1
	)

	echo [Orbyte] fnm was not found. Installing it with winget...
	winget install --id Schniz.fnm -e --accept-package-agreements --accept-source-agreements
	if errorlevel 1 exit /b 1

	rem WinGet exposes portable package commands through this directory. Add it
	rem now so a newly installed fnm can be used without restarting when possible.
	set "PATH=%LOCALAPPDATA%\Microsoft\WinGet\Links;%PATH%"
	where fnm >nul 2>nul
	if errorlevel 1 (
		echo [Orbyte] fnm was installed, but this Command Prompt cannot see it yet.
		echo [Orbyte] Close Command Prompt, open a new one, and run this script again.
		exit /b 1
	)
)

for /f "tokens=*" %%z in ('fnm env --use-on-cd --shell cmd') do call %%z

echo [Orbyte] Installing Node.js %ORBYTE_NODE_VERSION%...
fnm install %ORBYTE_NODE_VERSION%
if errorlevel 1 exit /b 1

fnm use %ORBYTE_NODE_VERSION%
if errorlevel 1 exit /b 1

for /f "delims=" %%v in ('node --version') do set "ORBYTE_ACTIVE_NODE=%%v"
if /i not "%ORBYTE_ACTIVE_NODE%"=="v%ORBYTE_NODE_VERSION%" (
	echo [Orbyte] Expected Node.js v%ORBYTE_NODE_VERSION%, but found %ORBYTE_ACTIVE_NODE%.
	exit /b 1
)

echo [Orbyte] Installing pnpm %ORBYTE_PNPM_VERSION%...
npm install --global pnpm@%ORBYTE_PNPM_VERSION%
if errorlevel 1 exit /b 1

for /f "delims=" %%v in ('pnpm --version') do set "ORBYTE_ACTIVE_PNPM=%%v"
if /i not "%ORBYTE_ACTIVE_PNPM%"=="%ORBYTE_PNPM_VERSION%" (
	echo [Orbyte] Expected pnpm %ORBYTE_PNPM_VERSION%, but found %ORBYTE_ACTIVE_PNPM%.
	exit /b 1
)

set "NODE_OPTIONS=--max-old-space-size=8192"
echo [Orbyte] Installing repository dependencies...
pnpm install --frozen-lockfile
if errorlevel 1 exit /b 1

echo [Orbyte] Setup complete with Node.js %ORBYTE_ACTIVE_NODE% and pnpm %ORBYTE_ACTIVE_PNPM%.
echo [Orbyte] Run: pnpm run compile
echo [Orbyte] Then: pnpm run orbyte:run:windows

