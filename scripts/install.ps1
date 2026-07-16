[CmdletBinding()]
param(
  [switch]$Refresh,
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

function Write-InstallLog([string]$Message) {
  Write-Host "[install] $Message"
}

function Write-Utf8NoBom([string]$Path, [string]$Content) {
  $parent = Split-Path -Parent $Path
  if ($parent) { [IO.Directory]::CreateDirectory($parent) | Out-Null }
  [IO.File]::WriteAllText($Path, $Content, [Text.UTF8Encoding]::new($false))
}

function Remove-PathIfPresent([string]$Path) {
  if (Test-Path -LiteralPath $Path) {
    Remove-Item -LiteralPath $Path -Recurse -Force
  }
}

function Resolve-Node {
  if ($env:CODEX_OTEL_NODE) {
    if (-not (Test-Path -LiteralPath $env:CODEX_OTEL_NODE -PathType Leaf)) {
      throw "CODEX_OTEL_NODE does not exist: $($env:CODEX_OTEL_NODE)"
    }
    return (Resolve-Path -LiteralPath $env:CODEX_OTEL_NODE).Path
  }
  $command = Get-Command node -ErrorAction SilentlyContinue
  if ($command) { return $command.Source }
  throw @"
Missing required command: node

codex-otel-plugin requires Node.js >= 22 because the Codex Stop hook runs as a Node.js script.
Install Node.js 22+ or set CODEX_OTEL_NODE to node.exe and retry.
"@
}

function Invoke-Codex([string[]]$Arguments, [switch]$IgnoreFailure) {
  & $script:CodexCommand @Arguments | Out-Host
  $exit = $LASTEXITCODE
  if ($exit -ne 0 -and -not $IgnoreFailure) {
    throw "codex $($Arguments -join ' ') failed with exit code $exit"
  }
  return $exit
}

if ($EnableScript -and $DisableScript) {
  throw "-EnableScript and -DisableScript cannot be used together."
}

$RepoRoot = if ($env:REPO_ROOT) { $env:REPO_ROOT } else { Split-Path -Parent $PSScriptRoot }
$CodexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE ".codex" }
if (-not $CodexConfig) {
  $CodexConfig = if ($env:CODEX_CONFIG_FILE) { $env:CODEX_CONFIG_FILE } else { Join-Path $CodexHome "config.toml" }
}
if (-not $ConfigFile) {
  $ConfigFile = if ($env:GTRACE_CONFIG_FILE) { $env:GTRACE_CONFIG_FILE } else { Join-Path $CodexHome "gtrace.json" }
}
if (-not $Endpoint) { $Endpoint = if ($env:GTRACE_ENDPOINT) { $env:GTRACE_ENDPOINT } else { $env:CODEX_OTEL_ENDPOINT } }
if (-not $XToken) { $XToken = if ($env:GTRACE_X_TOKEN) { $env:GTRACE_X_TOKEN } else { $env:X_TOKEN } }
if (-not $TracePath) { $TracePath = if ($env:GTRACE_TRACE_PATH) { $env:GTRACE_TRACE_PATH } else { $env:CODEX_OTEL_TRACE_PATH } }
if (-not $MetricsPath) { $MetricsPath = if ($env:GTRACE_METRICS_PATH) { $env:GTRACE_METRICS_PATH } else { $env:CODEX_OTEL_METRICS_PATH } }
if ($Type -eq "otel") { $Type = "otlp" }

$HookSource = Join-Path $RepoRoot "src\codex-hook-wrapper.js"
$ConfigHelper = Join-Path $RepoRoot "scripts\install-config.js"
if (-not (Test-Path -LiteralPath $HookSource -PathType Leaf)) { throw "Cannot find $HookSource" }
if (-not (Test-Path -LiteralPath $ConfigHelper -PathType Leaf)) { throw "Cannot find $ConfigHelper" }

$NodeBin = Resolve-Node
$NodeVersion = (& $NodeBin --version | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or $NodeVersion -notmatch '^v?(\d+)(?:\.|$)') {
  throw "Unable to determine Node.js version at $NodeBin. Output: $NodeVersion"
}
$NodeMajor = [int]$Matches[1]
if ($NodeMajor -lt 22) {
  throw "Node.js >= 22 is required. Found: $NodeVersion at $NodeBin"
}

$ConfigAlreadyExists = Test-Path -LiteralPath $ConfigFile -PathType Leaf
if (-not $TracePath -and ($Endpoint -or -not $ConfigAlreadyExists)) {
  $TracePath = if ($Type -eq "gtrace") { "v1/write/otel-llm" } else { "v1/traces" }
}
if (-not $MetricsPath -and ($Endpoint -or -not $ConfigAlreadyExists)) {
  $MetricsPath = if ($Type -eq "gtrace") { "v1/write/otel-metrics" } else { "v1/metrics" }
}

$MarketplaceName = "codex-otel-plugin"
$PluginName = "tracing"
$MarketplaceRoot = Join-Path $CodexHome "plugin-sources\$MarketplaceName"
$PluginRoot = Join-Path $MarketplaceRoot "plugins\$PluginName"
$PackageJsonPath = Join-Path $RepoRoot "package.json"
$PackageMetadata = Get-Content -LiteralPath $PackageJsonPath -Raw | ConvertFrom-Json
$Version = [string]$PackageMetadata.version
if ([string]::IsNullOrWhiteSpace($Version)) {
  throw "Cannot determine plugin version from $PackageJsonPath"
}
$CachePluginRoot = Join-Path $CodexHome "plugins\cache\$MarketplaceName\$PluginName\$Version"
$CacheHookScript = Join-Path $CachePluginRoot "src\codex-hook-wrapper.js"
$NodePowerShellLiteral = $NodeBin.Replace("'", "''")
$HookPowerShellLiteral = $CacheHookScript.Replace("'", "''")
$HookCommand = 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "& ''{0}'' ''{1}''"' -f $NodePowerShellLiteral, $HookPowerShellLiteral
$PluginSelector = "$PluginName@$MarketplaceName"
$ConflictingPluginSelectors = @("tracing@codex-observability-plugin")

[IO.Directory]::CreateDirectory((Join-Path $PluginRoot ".codex-plugin")) | Out-Null
[IO.Directory]::CreateDirectory((Join-Path $PluginRoot "hooks")) | Out-Null
[IO.Directory]::CreateDirectory((Join-Path $MarketplaceRoot ".agents\plugins")) | Out-Null

foreach ($legacy in @("src", "scripts", "test", "docs", "README.md", "AGENTS.md", "package.json", "package-lock.json")) {
  Remove-PathIfPresent (Join-Path $MarketplaceRoot $legacy)
}

Remove-PathIfPresent (Join-Path $PluginRoot "src")
Remove-PathIfPresent (Join-Path $PluginRoot "package.json")
Remove-PathIfPresent (Join-Path $PluginRoot "package-lock.json")
Copy-Item -LiteralPath (Join-Path $RepoRoot "src") -Destination (Join-Path $PluginRoot "src") -Recurse
Copy-Item -LiteralPath (Join-Path $RepoRoot "package.json") -Destination (Join-Path $PluginRoot "package.json")
if (Test-Path -LiteralPath (Join-Path $RepoRoot "package-lock.json")) {
  Copy-Item -LiteralPath (Join-Path $RepoRoot "package-lock.json") -Destination (Join-Path $PluginRoot "package-lock.json")
}

$Marketplace = [ordered]@{
  name = $MarketplaceName
  interface = [ordered]@{ displayName = "gtrace Codex Observe" }
  plugins = @([ordered]@{
    name = $PluginName
    source = [ordered]@{ source = "local"; path = "./plugins/$PluginName" }
    policy = [ordered]@{ installation = "AVAILABLE"; authentication = "ON_INSTALL" }
    category = "Coding"
  })
}
Write-Utf8NoBom (Join-Path $MarketplaceRoot ".agents\plugins\marketplace.json") (($Marketplace | ConvertTo-Json -Depth 10) + "`n")

$Manifest = [ordered]@{
  name = $PluginName
  version = $Version
  description = "Trace Codex sessions to GTrace through OTLP."
  author = [ordered]@{ name = "Guance" }
  hooks = "./hooks/hooks.json"
  interface = [ordered]@{
    displayName = "GTrace Codex Observe"
    shortDescription = "Trace Codex sessions to GTrace."
    longDescription = "Uploads Codex session traces to GTrace by using OpenTelemetry OTLP Trace HTTP/protobuf."
    developerName = "Guance"
    category = "Coding"
    capabilities = @("Read")
    defaultPrompt = @()
  }
}
Write-Utf8NoBom (Join-Path $PluginRoot ".codex-plugin\plugin.json") (($Manifest | ConvertTo-Json -Depth 10) + "`n")

$Hooks = [ordered]@{
  hooks = [ordered]@{
    Stop = @([ordered]@{
      hooks = @([ordered]@{
        type = "command"
        command = $HookCommand
        timeout = 60
        statusMessage = "Uploading Codex trace to GTrace"
      })
    })
  }
}
Write-Utf8NoBom (Join-Path $PluginRoot "hooks\hooks.json") (($Hooks | ConvertTo-Json -Depth 10) + "`n")

Write-Host "Wrote local marketplace: $MarketplaceRoot"
Write-Host "Wrote plugin: $PluginRoot"
Write-Host "Hook command: $HookCommand"

function Sync-PluginCache {
  [IO.Directory]::CreateDirectory((Split-Path -Parent $CachePluginRoot)) | Out-Null
  Remove-PathIfPresent $CachePluginRoot
  [IO.Directory]::CreateDirectory($CachePluginRoot) | Out-Null
  Copy-Item -Path (Join-Path $PluginRoot "*") -Destination $CachePluginRoot -Recurse -Force
  Copy-Item -Path (Join-Path $PluginRoot ".codex-plugin") -Destination $CachePluginRoot -Recurse -Force
  Write-InstallLog "updated plugin cache: $CachePluginRoot"
}

$env:CODEX_CONFIG_FILE_RUNTIME = $CodexConfig
$env:CODEX_MARKETPLACE_NAME_RUNTIME = $MarketplaceName
$env:CODEX_MARKETPLACE_ROOT_RUNTIME = $MarketplaceRoot
$env:CODEX_PLUGIN_SELECTOR_RUNTIME = $PluginSelector
$env:CODEX_CONFLICTING_PLUGIN_SELECTORS_RUNTIME = ConvertTo-Json -InputObject @($ConflictingPluginSelectors) -Compress
& $NodeBin $ConfigHelper write-codex-config
if ($LASTEXITCODE -ne 0) { throw "Failed to update $CodexConfig" }

Sync-PluginCache
Write-InstallLog "updated Codex config: $CodexConfig"

$ScriptEnabled = if ($EnableScript) { "true" } elseif ($DisableScript) { "false" } else { "" }
$ShouldWriteConfig = -not $NoConfig -and ($Endpoint -or (Test-Path -LiteralPath $ConfigFile) -or $ScriptEnabled)
if ($ShouldWriteConfig) {
  $env:GTRACE_CONFIG_FILE_RUNTIME = $ConfigFile
  $env:GTRACE_ENDPOINT_RUNTIME = $Endpoint
  $env:GTRACE_TRACE_PATH_RUNTIME = $TracePath
  $env:GTRACE_METRICS_PATH_RUNTIME = $MetricsPath
  $env:GTRACE_INSTALL_TYPE_RUNTIME = $Type
  $env:GTRACE_X_TOKEN_RUNTIME = $XToken
  $env:GTRACE_DEBUG_RUNTIME = if ($NoDebug) { "false" } else { "true" }
  $env:GTRACE_SCRIPT_ENABLED_RUNTIME = $ScriptEnabled
  $env:GTRACE_TAGS_RUNTIME = ConvertTo-Json -InputObject @($Tag) -Compress
  $env:GTRACE_HEADERS_RUNTIME = ConvertTo-Json -InputObject @($Header) -Compress
  & $NodeBin $ConfigHelper write-gtrace-config
  if ($LASTEXITCODE -ne 0) { throw "Failed to update $ConfigFile" }
  Write-InstallLog "updated $ConfigFile"
  if ($Endpoint) { Write-InstallLog "configured endpoint: $Endpoint" }
  Write-InstallLog "configured trace path: $TracePath"
  Write-InstallLog "configured metrics path: $MetricsPath"
  if ($XToken) { Write-InstallLog "configured X-Token: <redacted>" }
  if ($ScriptEnabled) { Write-InstallLog "configured enabled: $ScriptEnabled" }
} elseif ($NoConfig) {
  Write-InstallLog "skipped config because -NoConfig was set"
} else {
  Write-InstallLog "skipped config because -Endpoint was not provided"
}

$Codex = Get-Command codex -ErrorAction SilentlyContinue
if (-not $Codex) {
  Write-Host ""
  Write-Host "Codex CLI was not found. Plugin files and config were installed successfully."
  Write-Host "Restart Codex so the Stop hook is reloaded."
  exit 0
}
$script:CodexCommand = $Codex.Source

foreach ($selector in $ConflictingPluginSelectors) {
  Invoke-Codex -Arguments @("plugin", "remove", $selector) -IgnoreFailure | Out-Null
}

$MarketplaceList = (& $script:CodexCommand plugin marketplace list 2>&1 | Out-String)
if ($MarketplaceList -notmatch "(?m)^$([regex]::Escape($MarketplaceName))(\s|$)") {
  Invoke-Codex -Arguments @("plugin", "marketplace", "add", $MarketplaceRoot) | Out-Null
}
if ($Refresh) {
  Invoke-Codex -Arguments @("plugin", "remove", $PluginSelector) -IgnoreFailure | Out-Null
}
if ((Invoke-Codex -Arguments @("plugin", "add", $PluginSelector) -IgnoreFailure) -ne 0) {
  Write-Warning "Plugin files were written, but Codex CLI did not add the plugin automatically."
}
Sync-PluginCache

foreach ($obsolete in @(
  (Join-Path $CodexHome "codex-otel-plugin"),
  (Join-Path $CodexHome "marketplaces\$MarketplaceName")
)) {
  if ($obsolete -ne $MarketplaceRoot -and (Test-Path -LiteralPath $obsolete)) {
    Remove-PathIfPresent $obsolete
    Write-InstallLog "removed obsolete marketplace root: $obsolete"
  }
}

Write-Host ""
Write-Host "Installation complete. Restart Codex so the Stop hook is reloaded."
