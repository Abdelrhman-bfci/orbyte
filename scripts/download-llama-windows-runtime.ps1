param(
	[ValidateSet('x64', 'arm64')]
	[string]$Architecture = 'x64'
)

$ErrorActionPreference = 'Stop'
$Version = 'b12387'
$Checksums = @{
	'x64' = 'ced8482efac76c5f24398b97a6fe1662109038ec3b880686fd7c7c8f22bc5d99'
	'arm64' = 'd77e3fae0f188e2232b481eda455fca3b43f869ef3a6589e3499964f8df62358'
}
$LicenseChecksum = '94f29bbed6a22c35b992c5c6ebf0e7c92f13b836b90f36f461c9cf2f0f1d010d'
$Root = Split-Path -Parent $PSScriptRoot
$Target = Join-Path $Root "resources\local-llm\win32-$Architecture"
$Asset = "llama-$Version-bin-win-cpu-$Architecture.zip"
$Url = "https://github.com/ggml-org/llama.cpp/releases/download/$Version/$Asset"
$LicenseUrl = "https://raw.githubusercontent.com/ggml-org/llama.cpp/$Version/LICENSE"
$TemporaryRoot = Join-Path ([IO.Path]::GetTempPath()) "orbyte-llama-$Architecture-$([guid]::NewGuid().ToString('N'))"
$Archive = Join-Path $TemporaryRoot $Asset
$Extracted = Join-Path $TemporaryRoot 'extracted'
$License = Join-Path $TemporaryRoot 'llama.cpp-LICENSE'

try {
	New-Item -ItemType Directory -Force -Path $TemporaryRoot, $Extracted, $Target | Out-Null
	Write-Host "[Orbyte] Downloading llama.cpp $Version runtime for Windows $Architecture..."
	Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $Archive
	$ActualChecksum = (Get-FileHash -Algorithm SHA256 $Archive).Hash.ToLowerInvariant()
	if ($ActualChecksum -ne $Checksums[$Architecture]) {
		throw "llama.cpp archive checksum mismatch. Expected $($Checksums[$Architecture]), received $ActualChecksum."
	}

	Expand-Archive -LiteralPath $Archive -DestinationPath $Extracted -Force
	Copy-Item -Force (Join-Path $Extracted 'llama-server.exe') $Target
	Get-ChildItem -LiteralPath $Extracted -Filter '*.dll' -File | Copy-Item -Destination $Target -Force
	$OpenMpLicense = Join-Path $Extracted 'LICENSE-LLVM-OpenMP'
	if (Test-Path -LiteralPath $OpenMpLicense) {
		Copy-Item -Force $OpenMpLicense $Target
	}

	Invoke-WebRequest -UseBasicParsing -Uri $LicenseUrl -OutFile $License
	$ActualLicenseChecksum = (Get-FileHash -Algorithm SHA256 $License).Hash.ToLowerInvariant()
	if ($ActualLicenseChecksum -ne $LicenseChecksum) {
		throw "llama.cpp license checksum mismatch."
	}
	Copy-Item -Force $License (Join-Path $Target 'llama.cpp-LICENSE')

	$Server = Join-Path $Target 'llama-server.exe'
	if (-not (Test-Path -LiteralPath $Server)) {
		throw 'The llama.cpp archive did not contain llama-server.exe.'
	}
	Write-Host "[Orbyte] Installed Windows $Architecture llama.cpp $Version runtime at $Target."
}
finally {
	if (Test-Path -LiteralPath $TemporaryRoot) {
		Remove-Item -LiteralPath $TemporaryRoot -Recurse -Force
	}
}
