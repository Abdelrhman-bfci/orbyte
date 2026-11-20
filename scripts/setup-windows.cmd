@echo off
set "ORBYTE_NODE_VERSION=24.22.1"
set "ORBYTE_PNPM_VERSION=12.16.0"

rem Always run from the repository root, even when this script was called by path.
cd /d "%~dp0.."
if errorlevel 1 (
	echo [Orbyte] Could not enter the repository root.
	exit /b 1
)

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
rem Modern npm versions block dependency lifecycle scripts unless the package is
rem explicitly allowed. Authorize only pnpm's own install scripts.
npm install --global --allow-scripts=pnpm pnpm@%ORBYTE_PNPM_VERSION%
if errorlevel 1 exit /b 1

for /f "delims=" %%v in ('pnpm --version') do set "ORBYTE_ACTIVE_PNPM=%%v"
if /i not "%ORBYTE_ACTIVE_PNPM%"=="%ORBYTE_PNPM_VERSION%" (
	echo [Orbyte] Expected pnpm %ORBYTE_PNPM_VERSION%, but found %ORBYTE_ACTIVE_PNPM%.
	exit /b 1
)

call :ensure_cpp_build_tools
if errorlevel 1 exit /b 1

set "NODE_OPTIONS=--max-old-space-size=8192"
rem A machine-wide production setting makes pnpm omit build tools such as
rem npm-run-all2. Orbyte is a source checkout, so its devDependencies are required.
set "NODE_ENV="
set "NPM_CONFIG_PRODUCTION="
set "PNPM_CONFIG_PROD="
echo [Orbyte] Installing repository dependencies...
pnpm install --frozen-lockfile --prod=false
if errorlevel 1 exit /b 1

if not exist "node_modules\.bin\npm-run-all2.cmd" (
	echo [Orbyte] Dependency installation finished without npm-run-all2.
	echo [Orbyte] Remove any system NODE_ENV=production setting and run this script again.
	exit /b 1
)

echo [Orbyte] Setup complete with Node.js %ORBYTE_ACTIVE_NODE% and pnpm %ORBYTE_ACTIVE_PNPM%.
echo [Orbyte] Run: pnpm run compile
echo [Orbyte] Then: pnpm run orbyte:run:windows
exit /b 0

:ensure_cpp_build_tools
call :has_cpp_build_tools
if not errorlevel 1 exit /b 0

where winget >nul 2>nul
if errorlevel 1 (
	echo [Orbyte] Visual Studio C++ Build Tools are required but were not found.
	echo [Orbyte] Install the Desktop development with C++ workload and a Windows SDK.
	echo [Orbyte] See https://learn.microsoft.com/cpp/overview/acquire-msvc
	exit /b 1
)

echo [Orbyte] Visual Studio C++ Build Tools were not found.
echo [Orbyte] Installing the stable Build Tools with the C++ workload and Windows SDK...
echo [Orbyte] Accept the Windows elevation prompt. This download can take several minutes.
winget install --id Microsoft.VisualStudio.BuildTools -e --accept-package-agreements --accept-source-agreements --override "--wait --passive --norestart --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
if errorlevel 1 (
	echo [Orbyte] Visual Studio Build Tools installation failed.
	exit /b 1
)

call :has_cpp_build_tools
if errorlevel 1 (
	echo [Orbyte] Build Tools finished installing, but the C++ toolchain was not detected.
	echo [Orbyte] Open Visual Studio Installer, select Build Tools, and add Desktop development with C++.
	echo [Orbyte] Include MSVC x64/x86 build tools and a Windows 10 or Windows 11 SDK.
	exit /b 1
)
exit /b 0

:has_cpp_build_tools
if defined vs2026_install if exist "%vs2026_install%\VC\Tools\MSVC\*" exit /b 0
if defined vs2022_install if exist "%vs2022_install%\VC\Tools\MSVC\*" exit /b 0
if defined vs2019_install if exist "%vs2019_install%\VC\Tools\MSVC\*" exit /b 0

for %%y in (18 2022 2019) do (
	for %%e in (BuildTools Community Professional Enterprise Preview IntPreview) do (
		if exist "%ProgramFiles%\Microsoft Visual Studio\%%y\%%e\VC\Tools\MSVC\*" exit /b 0
		if exist "%ProgramFiles(x86)%\Microsoft Visual Studio\%%y\%%e\VC\Tools\MSVC\*" exit /b 0
	)
)
exit /b 1

