# Development and Debugging

This document describes local development commands, the debug ingest service, verification steps, and troubleshooting commands for `codex-otel-plugin`.

## Common Commands

```bash
npm test
npm ls --all
npm start
npm run codex:hook
```

`npm start` launches the local debug service, which listens on:

```text
http://localhost:3030
```

## Local Debug Service

Start it with:

```bash
npm start
```

Endpoints:

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/health` | Local service health check |
| `GET` | `/api/public/health` | OTLP ingest health check |
| `POST` | `/api/public/otel/v1/traces` | Accept OTLP Trace JSON/protobuf |
| `POST` | `/api/public/otel/v1/metrics` | Accept OTLP Metrics JSON/protobuf |
| `POST` | `/api/gtrace/v1/codex-spans` | Accept native JSON debug spans |
| `GET` | `/traces?limit=50` | List recent normalized spans |
| `GET` | `/metrics?limit=50` | List recent normalized metric data points |

Local output files:

```text
data/batches/*.json
data/spans.ndjson
data/metrics.ndjson
```

`data/` is for debugging only. It is not the source of truth for field definitions.

## Verification

After changing code, field semantics, or documentation wording, run at least:

```bash
npm test
npm ls --all
```

Expected results:

```text
14 tests passed
```

```text
gtrace@0.1.5 /home/liurui/code/codex-otel-plugin
└── (empty)
```

Current test coverage includes:

- OTLP JSON ingest
- OTLP protobuf ingest
- Codex hook rollout parsing and OTLP Trace / Metrics protobuf upload
- incomplete turns are skipped and uploaded only once after completion
- assistant spans are preserved while `tool -> skill` nesting reflects skill usage
- completed status inference when the Stop hook runs before `task_complete` is written
- blank startup turns are filtered and do not produce OTLP spans

## Troubleshooting

Inspect hook logs:

```bash
tail -n 100 ~/.codex/gtrace-hook.log
```

Inspect local ingest data:

```bash
curl "http://localhost:3030/traces?limit=20"
curl "http://localhost:3030/metrics?limit=20"
tail -n 20 data/spans.ndjson
tail -n 20 data/metrics.ndjson
ls -lt data/batches | head
```

Inspect uploaded-turn markers:

```bash
find ~/.codex/sessions -name "*.gtrace" -type f
```

Each `.gtrace` file stores `turnId<TAB>fingerprint` per line. Legacy files that contain only `turnId` are still read for compatibility.

Inspect concurrency lock files:

```bash
find ~/.codex/sessions -name "*.gtrace.lock" -type f
```

If the Stop hook fails, check these first:

- whether `~/.codex/gtrace.json` is enabled
- whether `endpoint`, `tracePath`, `metricsPath`, `otel_traces_url`, or `otel_metrics_url` point to the correct OTLP endpoint
- whether authentication headers are correct
- HTTP status codes and error messages in `~/.codex/gtrace-hook.log`
- if you see duplicate data, check for `skipped duplicate hook run` in `~/.codex/gtrace-hook.log`; that indicates concurrent hooks for the same transcript were suppressed by the lock
- check whether the matching transcript `.gtrace` keeps growing; terminal `completed` / `cancelled` turns are deduplicated by `turnId`, and once written into `.gtrace` they will not be uploaded again even if the fingerprint changes
- before parsing, the Stop hook briefly waits for the transcript file to stabilize so the same completed turn is not parsed with multiple fingerprints while the file tail is still being flushed
