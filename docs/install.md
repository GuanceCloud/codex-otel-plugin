# Installation and Upgrade

This document describes runtime requirements, installation methods, upgrade flow, uninstall steps, and installer arguments for `codex-otel-plugin`.

## Requirements

- Node.js >= 22
- `curl`, `tar`, and `gzip` are required for remote installation
- no runtime npm dependencies are required

Codex triggers the Stop hook, but it does not provide a Node.js runtime for the hook. The current hook is a Node.js script, so the target environment must have Node.js 22+ installed.

If Node.js is installed but unavailable in the non-interactive shell `PATH`, specify it explicitly:

```bash
curl -fsSL https://github.com/GuanceCloud/codex-otel-plugin/releases/latest/download/install-release.sh \
  | CODEX_OTEL_NODE=/path/to/node bash -s -- latest --endpoint <endpoint> --x-token <token>
```

## Remote Installation

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

## Install Files Only

To install plugin files without writing config yet:

```bash
curl -fsSL https://github.com/GuanceCloud/codex-otel-plugin/releases/latest/download/install-release.sh \
  | bash -s -- latest --no-config
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

## Upgrade

Use the same installer command to upgrade. If the environment is already installed, `--endpoint` and `--x-token` may be omitted because the script reuses the existing `~/.codex/gtrace.json`:

```bash
curl -fsSL https://github.com/GuanceCloud/codex-otel-plugin/releases/latest/download/install-release.sh \
  | bash -s -- latest
```

The upgrade flow re-downloads plugin files, rewrites plugin and hook config, updates `~/.codex/config.toml`, and refreshes the Codex plugin cache. It does not overwrite `~/.codex/gtrace.json`.

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

If you only want to disable the plugin while keeping installation files, running this is enough:

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
| `--no-config` | Install the plugin without writing `gtrace.json` |

## Development Install

To install from the current source tree:

```bash
git clone https://github.com/GuanceCloud/codex-otel-plugin.git
cd codex-otel-plugin
./scripts/install.sh --refresh --endpoint https://llm-openway.guance.com --x-token <token>
```
