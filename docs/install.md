# Installation and Upgrade

This document describes runtime requirements, installation methods, upgrade flow, uninstall steps, and installer arguments for `codex-otel-plugin`.

## Requirements

- Node.js >= 22
- Linux/macOS remote install: `curl`, `tar`, and `gzip`
- Windows remote install: Windows PowerShell 5.1+ or PowerShell 7+; the installer uses the built-in ZIP extraction support
- no runtime npm dependencies are required

Codex triggers the Stop hook, but it does not provide a Node.js runtime for the hook. The current hook is a Node.js script, so the target environment must have Node.js 22+ installed.

If Node.js is installed but unavailable in the non-interactive shell `PATH`, specify it explicitly:

```bash
curl -fsSL https://github.com/GuanceCloud/codex-otel-plugin/releases/latest/download/install-release.sh \
  | CODEX_OTEL_NODE=/path/to/node bash -s -- latest --endpoint <endpoint> --x-token <token>
```

## Linux and macOS Remote Installation

The remote installer is the recommended path. It does not require `git clone`:

```bash
curl -fsSL https://github.com/GuanceCloud/codex-otel-plugin/releases/latest/download/install-release.sh \
  | bash -s -- latest \
      --endpoint https://llm-openway.guance.com \
      --x-token <token>
```

The installer will:

- create a local Codex marketplace at `~/.codex/plugin-sources/codex-otel-plugin`
- write the plugin `tracing@codex-otel-plugin`
- remove the conflicting tracing plugin if present: it actively runs `codex plugin remove tracing@codex-observability-plugin` and cleans its stale `plugins.*` / `hooks.state.*` entries to avoid duplicate uploads for the same transcript
- write the Stop hook command: `node ~/.codex/plugins/cache/codex-otel-plugin/tracing/<version>/src/codex-hook-wrapper.js`
- update Codex config at `~/.codex/config.toml`
- sync the full runtime files into `~/.codex/plugins/cache/codex-otel-plugin/tracing/<version>`
- write upload config into `~/.codex/gtrace.json`

`~/.codex/config.toml` will contain entries like:

```toml
[marketplaces.codex-otel-plugin]
source_type = "local"
source = "/home/<user>/.codex/plugin-sources/codex-otel-plugin"

[plugins."tracing@codex-otel-plugin"]
enabled = true
```

See [configuration.md](configuration.md) for the default `~/.codex/gtrace.json` shape.

Restart Codex after installation so the Stop hook is reloaded.

## Windows Installation

Download and execute the PowerShell release installer:

```powershell
$installer = Join-Path $env:TEMP "codex-otel-install.ps1"
Invoke-WebRequest https://github.com/GuanceCloud/codex-otel-plugin/releases/latest/download/install-release.ps1 -OutFile $installer
powershell -ExecutionPolicy Bypass -File $installer `
  -Version latest `
  -Endpoint https://llm-openway.guance.com `
  -XToken "<token>"
```

When using PowerShell 7, replace `powershell` with `pwsh`. The remote installer downloads `codex-otel-plugin.zip`, expands it into a temporary directory, and invokes `scripts/install.ps1`. It creates the marketplace, plugin cache, hook JSON, `config.toml`, and `gtrace.json` under `%USERPROFILE%\.codex` by default. The generated hook command uses `powershell.exe` as a stable Windows launcher and safely quotes Node.js and plugin paths containing spaces.

For a development install from a local checkout:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1 `
  -Refresh `
  -Endpoint https://llm-openway.guance.com `
  -XToken "<token>"
```

Restart Codex after installation.

## Enable or Disable Collection

Keep the plugin installed and turn its hook work on or off with `enabled` in `%USERPROFILE%\.codex\gtrace.json` (Windows) or `~/.codex/gtrace.json` (Linux/macOS):

```json
{
  "enabled": false
}
```

When disabled, the Stop hook exits before reading stdin or the transcript and sends no trace or metric requests. A normal install or upgrade preserves an existing `enabled` value. To change it explicitly during installation:

```bash
./scripts/install.sh --disable-script
./scripts/install.sh --enable-script
```

```powershell
.\scripts\install.ps1 -DisableScript
.\scripts\install.ps1 -EnableScript
```

## Install Files Only

To install plugin files without writing config yet:

```bash
curl -fsSL https://github.com/GuanceCloud/codex-otel-plugin/releases/latest/download/install-release.sh \
  | bash -s -- latest --no-config
```

Windows PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1 -NoConfig
```

## Minimum Validation

After installation, check at least:

```bash
codex plugin list
codex plugin marketplace list
find ~/.codex/plugins/cache/codex-otel-plugin/tracing -maxdepth 2 -type d | sort
cat ~/.codex/gtrace.json
```

Expected results:

- `codex plugin list` includes `tracing@codex-otel-plugin` with `installed, enabled`
- if `codex-observability-plugin` was installed before, its `tracing` plugin should be removed
- `codex plugin marketplace list` includes `codex-otel-plugin`
- the cache directory contains a version directory such as `~/.codex/plugins/cache/codex-otel-plugin/tracing/0.1.5`
- `~/.codex/gtrace.json` contains `endpoint`, `tracePath`, `metricsPath`, and `headers.X-Token`

Windows PowerShell equivalents for the filesystem and config checks are:

```powershell
Get-ChildItem "$env:USERPROFILE\.codex\plugins\cache\codex-otel-plugin\tracing" -Directory
Get-Content "$env:USERPROFILE\.codex\gtrace.json"
```

## Upgrade

Use the same installer command to upgrade. If the environment is already installed, `--endpoint` and `--x-token` may be omitted because the script reuses the existing `~/.codex/gtrace.json`:

```bash
curl -fsSL https://github.com/GuanceCloud/codex-otel-plugin/releases/latest/download/install-release.sh \
  | bash -s -- latest
```

The upgrade flow re-downloads plugin files, rewrites plugin and hook config, updates `~/.codex/config.toml`, refreshes the Codex plugin cache, and merges installer-managed values into the existing `gtrace.json`. Existing endpoint/path values are kept when they are not supplied, and `enabled` is preserved unless an explicit enable/disable flag is used. On Windows, rerun the same `install-release.ps1` command; `-Endpoint` and `-XToken` may likewise be omitted.

Install a specific version:

```bash
curl -fsSL https://github.com/GuanceCloud/codex-otel-plugin/releases/latest/download/install-release.sh \
  | bash -s -- v0.1.5
```

To use a custom release asset URL, override the download URL:

```bash
curl -fsSL https://github.com/GuanceCloud/codex-otel-plugin/releases/latest/download/install-release.sh \
  | CODEX_OTEL_ARCHIVE_URL=<plugin-release-tar-gz-url> bash -s -- latest --endpoint <endpoint> --x-token <token>
```

## Uninstall

Remove only the plugin:

```bash
codex plugin remove tracing@codex-otel-plugin
```

Fully remove the local source, cache, and upload config:

```bash
codex plugin remove tracing@codex-otel-plugin
codex plugin marketplace remove codex-otel-plugin
rm -rf ~/.codex/plugin-sources/codex-otel-plugin
rm -rf ~/.codex/plugins/cache/codex-otel-plugin
rm -f ~/.codex/gtrace.json
```

Windows PowerShell:

```powershell
codex plugin remove tracing@codex-otel-plugin
codex plugin marketplace remove codex-otel-plugin
Remove-Item "$env:USERPROFILE\.codex\plugin-sources\codex-otel-plugin" -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item "$env:USERPROFILE\.codex\plugins\cache\codex-otel-plugin" -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item "$env:USERPROFILE\.codex\gtrace.json" -Force -ErrorAction SilentlyContinue
```

If you only want to pause collection while keeping the plugin installed, set `enabled=false` or use the installer disable switch described above. To disable plugin loading entirely while keeping its files, remove it from Codex:

```bash
codex plugin remove tracing@codex-otel-plugin
```

Do not manually delete `~/.codex/plugin-sources/codex-otel-plugin` before running `codex plugin list` or `codex plugin marketplace list`. If the marketplace entry still exists while the source directory has already been removed, Codex reports a missing marketplace manifest.

## Installer Arguments

| Argument | Description |
| --- | --- |
| `latest` / `vX.Y.Z` / `X.Y.Z` | Version to install. Default: `latest` |
| `--endpoint URL` | Receiver base URL, for example `https://llm-openway.guance.com` |
| `--x-token TOKEN` | Writes `headers.X-Token` |
| `--trace-path PATH` | Trace upload path. Default for GTrace: `v1/write/otel-llm` |
| `--metrics-path PATH` | Metrics upload path. Default for GTrace: `v1/write/otel-metrics` |
| `--type gtrace|otlp` | Config preset. Default: `gtrace` |
| `--header KEY=VALUE` | Extra HTTP header. Repeatable |
| `--tag KEY=VALUE` | Extra global resource attribute. Repeatable |
| `--config-file PATH` | Upload config path. Default: `~/.codex/gtrace.json` |
| `--codex-config PATH` | Codex config path. Default: `~/.codex/config.toml` |
| `--enable-script` | Explicitly write `enabled=true`; aliases: `--enable` |
| `--disable-script` | Explicitly write `enabled=false`; aliases: `--disable` |
| `--no-config` | Install the plugin without writing `gtrace.json` |

PowerShell uses the corresponding parameter names: `-Endpoint`, `-XToken`, `-TracePath`, `-MetricsPath`, `-Type`, repeated/array `-Header` and `-Tag`, `-ConfigFile`, `-CodexConfig`, `-EnableScript`, `-DisableScript`, `-NoConfig`, and `-Refresh`.

## Development Install

To install from the current source tree:

```bash
git clone https://github.com/GuanceCloud/codex-otel-plugin.git
cd codex-otel-plugin
./scripts/install.sh --refresh --endpoint https://llm-openway.guance.com --x-token <token>
```
