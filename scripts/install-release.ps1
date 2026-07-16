[CmdletBinding()]
param(
  [string]$Version = "latest",
  [ValidateSet("gtrace", "otlp", "otel")][string]$Type = "gtrace",
  [string]$Endpoint,
  [string]$XToken,
  [string]$TracePath,
  [string]$MetricsPath,
  [string[]]$Header = @(),
  [string[]]$Tag = @(),
  [string]$ConfigFile,
  [string]$CodexConfig,
  [switch]$EnableScript,
  [switch]$DisableScript,
  [switch]$NoConfig,
  [switch]$NoDebug
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Repo = if ($env:CODEX_OTEL_REPO) { $env:CODEX_OTEL_REPO } else { "GuanceCloud/codex-otel-plugin" }
if ($env:CODEX_OTEL_VERSION) { $Version = $env:CODEX_OTEL_VERSION }
$AssetName = if ($env:CODEX_OTEL_RELEASE_ASSET_NAME) { $env:CODEX_OTEL_RELEASE_ASSET_NAME } else { "codex-otel-plugin.zip" }

if ($Version -ne "latest" -and -not $Version.StartsWith("v")) {
  $Version = "v$Version"
}

if ($env:CODEX_OTEL_ARCHIVE_URL) {
  $ArchiveUrl = $env:CODEX_OTEL_ARCHIVE_URL
} elseif ($Version -eq "latest") {
  $ArchiveUrl = "https://github.com/$Repo/releases/latest/download/$AssetName"
} else {
  $ArchiveUrl = "https://github.com/$Repo/releases/download/$Version/$AssetName"
}

$TempRoot = Join-Path ([IO.Path]::GetTempPath()) ("codex-otel-plugin-" + [guid]::NewGuid().ToString("N"))
$ArchivePath = Join-Path $TempRoot $AssetName
$ExtractPath = Join-Path $TempRoot "repo"

try {
  [IO.Directory]::CreateDirectory($ExtractPath) | Out-Null
  Write-Host "Downloading $ArchiveUrl"
  Invoke-WebRequest -UseBasicParsing -Uri $ArchiveUrl -OutFile $ArchivePath
  Expand-Archive -LiteralPath $ArchivePath -DestinationPath $ExtractPath -Force

  $Installer = Join-Path $ExtractPath "scripts\install.ps1"
  if (-not (Test-Path -LiteralPath $Installer -PathType Leaf)) {
    throw "Release archive does not contain scripts/install.ps1"
  }

  $InstallParameters = @{
    Refresh = $true
    Type = $Type
    Header = $Header
    Tag = $Tag
  }
  if ($Endpoint) { $InstallParameters.Endpoint = $Endpoint }
  if ($XToken) { $InstallParameters.XToken = $XToken }
  if ($TracePath) { $InstallParameters.TracePath = $TracePath }
  if ($MetricsPath) { $InstallParameters.MetricsPath = $MetricsPath }
  if ($ConfigFile) { $InstallParameters.ConfigFile = $ConfigFile }
  if ($CodexConfig) { $InstallParameters.CodexConfig = $CodexConfig }
  if ($EnableScript) { $InstallParameters.EnableScript = $true }
  if ($DisableScript) { $InstallParameters.DisableScript = $true }
  if ($NoConfig) { $InstallParameters.NoConfig = $true }
  if ($NoDebug) { $InstallParameters.NoDebug = $true }

  Write-Host "Installing plugin from temporary archive"
  & $Installer @InstallParameters
  if (-not $?) { throw "Plugin installer failed." }
} finally {
  if (Test-Path -LiteralPath $TempRoot) {
    Remove-Item -LiteralPath $TempRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}
