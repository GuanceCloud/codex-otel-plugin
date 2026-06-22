import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import { createServer } from "../src/server.js";
import { collectRollout } from "../src/codex-collector.js";
import { parseSession } from "../src/codex-parse.js";
import { encodeExportTraceServiceRequest } from "../src/proto.js";

let server;
let baseUrl;
let dataDir;

before(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "gtrace-"));
  server = createServer({
    dataDir,
    publicKey: "pk-test",
    secretKey: "sk-test",
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

test("accepts canonical OTLP trace protobuf and stores normalized Codex spans", async () => {
  const payload = buildTracePayload();
  const response = await fetch(`${baseUrl}/api/public/otel/v1/traces`, {
    method: "POST",
    headers: {
      authorization: `Basic ${Buffer.from("pk-test:sk-test").toString("base64")}`,
      "content-type": "application/x-protobuf",
      "x-gtrace-sdk-name": "otel-test",
      "x-gtrace-sdk-version": "1.0.0",
    },
    body: payload,
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-gtrace-span-count"), "3");

  const lines = (await readFile(path.join(dataDir, "spans.ndjson"), "utf-8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));

  assert.equal(lines.length, 3);
  assert.deepEqual(
    lines.map((span) => span.gtrace.observation.type),
    ["agent", "llm", "tool"],
  );
  assert.equal(lines[0].gtrace.trace.session_id, "codex-session-1");
  assert.equal(lines[1].gtrace.observation.model_name, "gpt-test");
  assert.deepEqual(lines[1].gtrace.observation.usage, {
    input: 10,
    output: 20,
    total: 30,
    cache_read_input_tokens: 2,
    reasoning_tokens: 3,
  });
  assert.equal(lines[2].attributes.reason, "command failed");
});

test("accepts OTLP trace JSON used by @opentelemetry/exporter-trace-otlp-http", async () => {
  const response = await fetch(`${baseUrl}/api/public/otel/v1/traces`, {
    method: "POST",
    headers: {
      authorization: `Basic ${Buffer.from("pk-test:sk-test").toString("base64")}`,
      "content-type": "application/json",
      "x-gtrace-sdk-name": "otel-json-test",
    },
    body: JSON.stringify({
      resourceSpans: [
        {
          resource: { attributes: [attr("service.name", "codex")] },
          scopeSpans: [
            {
              scope: { name: "gtrace-otel-test" },
              spans: [
                {
                  traceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                  spanId: "bbbbbbbbbbbbbbbb",
                  parentSpanId: "",
                  name: "Codex Turn",
                  kind: 1,
                  startTimeUnixNano: "1800000000000000000",
                  endTimeUnixNano: "1800000000100000000",
                  attributes: [
                    attr("gen_ai.conversation.id", "codex-json-session"),
                    attr("gen_ai.request.model", "gpt-json"),
                    attr("gen_ai.response.model", "gpt-json"),
                  ],
                  status: { code: 0 },
                },
              ],
            },
          ],
        },
      ],
    }),
  });

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /application\/json/);
  assert.equal(await response.text(), "{}\n");

  const listed = await fetch(`${baseUrl}/traces?limit=1`).then((res) => res.json());
  assert.equal(listed.data[0].trace_id, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  assert.equal(listed.data[0].span_id, "bbbbbbbbbbbbbbbb");
  assert.equal(listed.data[0].gtrace.trace.session_id, "codex-json-session");
});

test("native gtrace Codex hook parses rollout and uploads spans as OTLP protobuf", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "gtrace-hook-home-"));
  const sessionDir = path.join(home, "sessions");
  await mkdirp(path.join(home, ".codex"));
  await mkdirp(sessionDir);

  const rollout = path.join(sessionDir, "rollout-basic-main.jsonl");
  await writeFile(rollout, buildCodexRolloutFixture(), "utf-8");
  await writeFile(
    path.join(home, ".codex", "gtrace.json"),
    JSON.stringify(
      {
        enabled: true,
        public_key: "pk-test",
        secret_key: "sk-test",
        endpoint: baseUrl,
        tracePath: "api/public/otel/v1/traces",
        metricsPath: "api/public/otel/v1/metrics",
        headers: {
          "x-gtrace-sdk-name": "gtrace-codex",
        },
        tags: ["app_name=Codex OTEL", "agent_source=codex-cli"],
        resourceAttributes: {
          "deployment.environment": "test",
          app_id: "codex-monitor",
          agent_type: "assistant",
        },
        debug: true,
        fail_on_error: true,
        hook_log_file: path.join(home, ".codex", "gtrace-hook.log"),
      },
      null,
      2,
    ),
  );

  const hookPayload = JSON.stringify({ transcript_path: rollout });
  const result = await spawnHook(process.execPath, ["src/codex-hook-wrapper.js"], {
    cwd: path.resolve(import.meta.dirname, ".."),
    input: hookPayload,
    env: {
      ...process.env,
      HOME: home,
      CODEX_HOME: path.join(home, ".codex"),
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(await readFile(`${rollout}.gtrace`, "utf-8"), /turn-1/);
  assert.match(await readFile(path.join(home, ".codex", "gtrace-hook.log"), "utf-8"), /uploaded spans/);
  assert.match(await readFile(path.join(home, ".codex", "gtrace-hook.log"), "utf-8"), /uploaded metrics/);

  const batch = await latestTraceBatch();
  const uploadedSpans = batch.raw_request.resourceSpans[0].scopeSpans[0].spans;
  assert.ok(batch.raw_request.resourceSpans, "hook should upload OTLP resourceSpans");
  assert.equal(batch.raw_request.type, undefined);
  assert.match(batch.ingest.content_type, /application\/x-protobuf/);
  assert.equal(batch.ingest.sdk_name, "gtrace-codex");
  assert.equal(
    attrValue(batch.raw_request.resourceSpans[0].resource.attributes, "service.name"),
    "gtrace-codex",
  );
  const traceResourceAttrs = batch.raw_request.resourceSpans[0].resource.attributes;
  assert.equal(typeof attrValue(traceResourceAttrs, "host"), "string");
  assert.ok(attrValue(traceResourceAttrs, "host").length > 0);
  assert.equal(attrValue(traceResourceAttrs, "deployment.environment"), "test");
  assert.equal(attrValue(traceResourceAttrs, "app_id"), "codex-monitor");
  assert.equal(attrValue(traceResourceAttrs, "app_name"), "Codex OTEL");
  assert.equal(attrValue(traceResourceAttrs, "agent_type"), "assistant");
  assert.equal(attrValue(traceResourceAttrs, "agent_source"), "codex-cli");
  assert.deepEqual(
    collectOtlpAttributeKeys(batch.raw_request).filter((key) => key.startsWith("gtrace.")),
    [],
  );
  assert.equal(collectOtlpAttributeKeys(batch.raw_request).includes("request_model"), false);
  assert.equal(collectOtlpAttributeKeys(batch.raw_request).includes("response_model"), false);
  assert.equal(collectOtlpAttributeKeys(batch.raw_request).includes("session_key"), false);
  assert.equal(collectOtlpAttributeKeys(batch.raw_request).includes("session_id"), true);
  assert.equal(collectOtlpAttributeKeys(batch.raw_request).includes("session_agent"), false);
  assert.equal(collectOtlpAttributeKeys(batch.raw_request).includes("provider_name"), false);
  assert.equal(collectOtlpAttributeKeys(batch.raw_request).includes("model_name"), false);
  assert.equal(collectOtlpAttributeKeys(batch.raw_request).includes("usage_input_tokens"), false);
  assert.equal(collectOtlpAttributeKeys(batch.raw_request).includes("usage_output_tokens"), false);
  assert.equal(collectOtlpAttributeKeys(batch.raw_request).includes("usage_total_tokens"), false);
  assert.equal(collectOtlpAttributeKeys(batch.raw_request).includes("tool_name"), false);
  assert.equal(collectOtlpAttributeKeys(batch.raw_request).includes("tool_call_id"), false);
  assert.equal(collectOtlpAttributeKeys(batch.raw_request).includes("tool_args_preview"), false);
  assert.equal(collectOtlpAttributeKeys(batch.raw_request).includes("tool_result_preview"), false);
  assert.equal(uploadedSpans[0].name, "invoke_agent");
  assert.equal(uploadedSpans[1].name, "llm");
  assert.equal(
    attrValue(uploadedSpans[0].attributes, "gen_ai.request.model"),
    "gpt-5.4",
  );
  assert.equal(
    attrValue(uploadedSpans[0].attributes, "gen_ai.response.model"),
    "gpt-5.4",
  );
  assert.equal(
    attrValue(uploadedSpans[0].attributes, "gen_ai.provider.name"),
    "openai",
  );
  assert.equal(attrValue(uploadedSpans[0].attributes, "gen_ai.conversation.id"), "sess-basic");
  assert.equal(attrValue(uploadedSpans[0].attributes, "session_id"), "sess-basic");
  assert.equal(attrValue(uploadedSpans[0].attributes, "gen_ai.agent.name"), "codex");
  assert.equal(attrValue(uploadedSpans[0].attributes, "gen_ai.operation.name"), "invoke_agent");
  assert.equal(
    attrValue(uploadedSpans[0].attributes, "final_status"),
    "completed",
  );
  const agentRun = uploadedSpans[0];
  assert.equal(attrValue(agentRun.attributes, "session_create_at"), "2026-06-03T09:59:58.000Z");
  assert.equal(attrValue(agentRun.attributes, "session_updated_at"), "2026-06-03T10:00:04.400Z");
  assert.equal(attrValue(agentRun.attributes, "session_channel"), "cli");
  assert.equal(attrValue(agentRun.attributes, "gen_ai.usage.input_tokens"), 250);
  assert.equal(attrValue(agentRun.attributes, "gen_ai.usage.cache_read.input_tokens"), 50);
  assert.equal(attrValue(agentRun.attributes, "gen_ai.usage.output_tokens"), 50);
  assert.equal(attrValue(agentRun.attributes, "gen_ai.usage.reasoning.output_tokens"), 5);
  assert.deepEqual(attrValue(agentRun.attributes, "gen_ai.input.messages"), [
    {
      role: "user",
      parts: [{ type: "text", content: "List the files in the repo" }],
    },
  ]);
  assert.deepEqual(attrValue(agentRun.attributes, "gen_ai.output.messages"), [
    {
      role: "assistant",
      parts: [{ type: "text", content: "There are two files: file1.txt and file2.txt." }],
      finish_reason: "stop",
    },
  ]);

  const llmSpans = uploadedSpans.filter((span) => span.name === "llm");
  assert.ok(llmSpans.every((span) => spanEndNs(span) > spanStartNs(span)));
  assert.ok(llmSpans.every((span) => attrValue(span.attributes, "session_key") === undefined));
  assert.ok(llmSpans.every((span) => attrValue(span.attributes, "gen_ai.operation.name") === "chat"));
  const firstLlm = llmSpans.find((span) => attrValue(span.attributes, "step_index") === 0);
  assert.deepEqual(attrValue(firstLlm.attributes, "gen_ai.input.messages"), [
    {
      role: "user",
      parts: [{ type: "text", content: "List the files in the repo" }],
    },
  ]);
  assert.deepEqual(attrValue(firstLlm.attributes, "gen_ai.output.messages"), [
    {
      role: "assistant",
      parts: [
        { type: "reasoning", content: "I'll list files with ls." },
        { type: "tool_call", name: "exec_command", id: "call-1", arguments: '{"command":["ls"]}' },
      ],
      finish_reason: "tool_call",
    },
  ]);
  const cachedLlm = llmSpans.find(
    (span) => attrValue(span.attributes, "gen_ai.usage.cache_read.input_tokens") === 50,
  );
  assert.equal(attrValue(cachedLlm.attributes, "gen_ai.usage.input_tokens"), 150);
  assert.equal(attrValue(cachedLlm.attributes, "gen_ai.usage.cache_read.input_tokens"), 50);
  assert.equal(attrValue(cachedLlm.attributes, "gen_ai.usage.output_tokens"), 30);
  assert.deepEqual(attrValue(cachedLlm.attributes, "gen_ai.input.messages"), [
    {
      role: "tool",
      name: "exec_command",
      parts: [
        {
          type: "tool_call_response",
          id: "call-1",
          response: "file1.txt\nfile2.txt",
        },
      ],
    },
  ]);
  assert.deepEqual(attrValue(cachedLlm.attributes, "gen_ai.output.messages"), [
    {
      role: "assistant",
      parts: [{ type: "text", content: "There are two files: file1.txt and file2.txt." }],
      finish_reason: "stop",
    },
  ]);

  const assistantSpan = uploadedSpans.find((span) => span.name === "assistant");
  assert.equal(attrValue(assistantSpan.attributes, "role"), "assistant");
  assert.equal(
    attrValue(assistantSpan.attributes, "output_preview"),
    "There are two files: file1.txt and file2.txt.",
  );
  assert.equal(
    attrValue(assistantSpan.attributes, "assistant_message_start_time"),
    "2026-06-03T10:00:04.000Z",
  );
  assert.equal(
    attrValue(assistantSpan.attributes, "assistant_message_event_time"),
    "2026-06-03T10:00:04.300Z",
  );

  const listed = await fetch(`${baseUrl}/traces?limit=5`).then((res) => res.json());
  assert.deepEqual(
    listed.data.map((span) => span.gtrace.observation.type).sort(),
    ["agent", "assistant", "llm", "llm", "tool"].sort(),
  );
  const toolSpan = uploadedSpans.find((span) => span.name === "tool:exec_command");
  assert.equal(attrValue(toolSpan.attributes, "tool_command"), "ls");
  assert.equal(attrValue(toolSpan.attributes, "gen_ai.operation.name"), "execute_tool");
  assert.equal(attrValue(toolSpan.attributes, "gen_ai.tool.name"), "exec_command");
  assert.equal(attrValue(toolSpan.attributes, "gen_ai.tool.call.id"), "call-1");
  assert.equal(attrValue(toolSpan.attributes, "gen_ai.tool.call.arguments"), '{"command":["ls"]}');
  assert.equal(attrValue(toolSpan.attributes, "gen_ai.tool.call.result"), "file1.txt file2.txt");
  assert.ok(spanEndNs(toolSpan) <= spanEndNs(cachedLlm));
  assert.equal(listed.data.at(-1).gtrace.trace.session_id, "sess-basic");
  assert.equal(
    listed.data.find((span) => span.gtrace.observation.type === "llm").gtrace.observation.model_name,
    "gpt-5.4",
  );

  const metricsBatch = await latestMetricsBatch();
  assert.ok(metricsBatch.raw_request.resourceMetrics, "hook should upload OTLP resourceMetrics");
  assert.match(metricsBatch.ingest.content_type, /application\/x-protobuf/);
  assert.equal(metricsBatch.ingest.sdk_name, "gtrace-codex");
  const metricResourceAttrs = metricsBatch.raw_request.resourceMetrics[0].resource.attributes;
  assert.equal(typeof attrValue(metricResourceAttrs, "host"), "string");
  assert.ok(attrValue(metricResourceAttrs, "host").length > 0);
  assert.equal(attrValue(metricResourceAttrs, "deployment.environment"), "test");
  assert.equal(attrValue(metricResourceAttrs, "app_id"), "codex-monitor");
  assert.equal(attrValue(metricResourceAttrs, "app_name"), "Codex OTEL");
  assert.equal(metricsBatch.metrics[0].resource.app_id, "codex-monitor");
  assert.equal(metricsBatch.metric_count, 8);
  assert.deepEqual(
    Array.from(new Set(metricsBatch.metrics.map((metric) => metric.name))).sort(),
    [
      "gen_ai.client.operation.duration",
      "gen_ai.client.token.usage",
      "gen_ai.workflow.duration",
    ],
  );
  assert.ok(metricsBatch.metrics.every((metric) => metric.attributes["gen_ai.conversation.id"] === "sess-basic"));
  assert.ok(metricsBatch.metrics.every((metric) => metric.attributes.session_key === undefined));
  assert.ok(metricsBatch.metrics.every((metric) => metric.attributes.run_id === undefined));
  assert.ok(metricsBatch.metrics.every((metric) => metric.attributes.session_id === "sess-basic"));
  assert.ok(metricsBatch.metrics.every((metric) => metric.attributes.operation_name === undefined));
  assert.ok(metricsBatch.metrics.every((metric) => metric.attributes.token_type === undefined));
  assert.deepEqual(
    Array.from(
      new Set(
        metricsBatch.metrics
          .filter((metric) => metric.name === "gen_ai.client.token.usage")
          .map((metric) => metric.attributes["gen_ai.token.type"]),
      ),
    ).sort(),
    ["input", "output"],
  );
  const workflowDuration = metricsBatch.metrics.find((metric) => metric.name === "gen_ai.workflow.duration");
  assert.equal(workflowDuration.unit, "s");
  assert.equal(workflowDuration.sum, 3.4);
  const toolOperation = metricsBatch.metrics.find(
    (metric) =>
      metric.name === "gen_ai.client.operation.duration" &&
      metric.attributes["gen_ai.operation.name"] === "execute_tool",
  );
  assert.equal(toolOperation.unit, "s");
  assert.equal(toolOperation.attributes["gen_ai.tool.name"], "exec_command");
  assert.equal(toolOperation.attributes.tool_result_status, "completed");

  const listedMetrics = await fetch(`${baseUrl}/metrics?limit=20`).then((res) => res.json());
  assert.ok(listedMetrics.data.some((metric) => metric.name === "gen_ai.client.token.usage"));
});

test("concurrent Codex hooks only upload one copy for the same transcript", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "gtrace-hook-race-home-"));
  const sessionDir = path.join(home, "sessions");
  await mkdirp(path.join(home, ".codex"));
  await mkdirp(sessionDir);

  const rollout = path.join(sessionDir, "rollout-race-main.jsonl");
  await writeFile(rollout, buildCodexRolloutFixture(), "utf-8");
  await writeFile(
    path.join(home, ".codex", "gtrace.json"),
    JSON.stringify(
      {
        enabled: true,
        public_key: "pk-test",
        secret_key: "sk-test",
        endpoint: baseUrl,
        tracePath: "api/public/otel/v1/traces",
        metricsPath: "api/public/otel/v1/metrics",
        headers: {
          "x-gtrace-sdk-name": "gtrace-codex-race",
        },
        debug: true,
        fail_on_error: true,
        hook_log_file: path.join(home, ".codex", "gtrace-hook.log"),
      },
      null,
      2,
    ),
  );

  const beforeTraceBatches = await countBatches((batch) => batch.span_count > 0);
  const beforeMetricBatches = await countBatches((batch) => batch.metric_count > 0);
  const hookPayload = JSON.stringify({ transcript_path: rollout });
  const env = {
    ...process.env,
    HOME: home,
    CODEX_HOME: path.join(home, ".codex"),
  };

  const [first, second] = await Promise.all([
    spawnHook(process.execPath, ["src/codex-hook-wrapper.js"], {
      cwd: path.resolve(import.meta.dirname, ".."),
      input: hookPayload,
      env,
    }),
    spawnHook(process.execPath, ["src/codex-hook-wrapper.js"], {
      cwd: path.resolve(import.meta.dirname, ".."),
      input: hookPayload,
      env,
    }),
  ]);

  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(await countBatches((batch) => batch.span_count > 0), beforeTraceBatches + 1);
  assert.equal(await countBatches((batch) => batch.metric_count > 0), beforeMetricBatches + 1);
  assert.match(await readFile(`${rollout}.gtrace`, "utf-8"), /^turn-1\t[0-9a-f]+\n$/);

  const log = await readFile(path.join(home, ".codex", "gtrace-hook.log"), "utf-8");
  assert.match(log, /uploaded spans/);
  assert.match(log, /skipped duplicate hook run/);

  await assert.rejects(stat(`${rollout}.gtrace.lock`), { code: "ENOENT" });
});

test("sequential Codex hooks do not re-upload an unchanged incomplete turn", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "gtrace-hook-open-home-"));
  const sessionDir = path.join(home, "sessions");
  await mkdirp(path.join(home, ".codex"));
  await mkdirp(sessionDir);

  const rollout = path.join(sessionDir, "rollout-open-main.jsonl");
  await writeFile(
    rollout,
    `${[
      row("2026-06-03T10:00:00.000Z", "session_meta", {
        id: "sess-open",
        cli_version: "0.140.0",
        model_provider: "openai",
        timestamp: "2026-06-03T09:59:58.000Z",
        source: "cli",
      }),
      row("2026-06-03T10:00:01.000Z", "event_msg", {
        type: "task_started",
        turn_id: "turn-open",
      }),
      row("2026-06-03T10:00:01.100Z", "turn_context", {
        model: "gpt-5.4",
      }),
      row("2026-06-03T10:00:01.200Z", "event_msg", {
        type: "user_message",
        message: "Check current status",
      }),
      row("2026-06-03T10:00:02.000Z", "response_item", {
        type: "reasoning",
        summary: [{ text: "Need more information before answering." }],
      }),
      row("2026-06-03T10:00:02.200Z", "event_msg", {
        type: "token_count",
        info: {
          last_token_usage: {
            input_tokens: 10,
            output_tokens: 2,
            total_tokens: 12,
          },
        },
      }),
    ].map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    "utf-8",
  );
  await writeFile(
    path.join(home, ".codex", "gtrace.json"),
    JSON.stringify(
      {
        enabled: true,
        public_key: "pk-test",
        secret_key: "sk-test",
        endpoint: baseUrl,
        tracePath: "api/public/otel/v1/traces",
        metricsPath: "api/public/otel/v1/metrics",
        headers: {
          "x-gtrace-sdk-name": "gtrace-codex-open",
        },
        debug: true,
        fail_on_error: true,
        hook_log_file: path.join(home, ".codex", "gtrace-hook.log"),
      },
      null,
      2,
    ),
  );

  const beforeTraceBatches = await countBatches((batch) => batch.span_count > 0);
  const beforeMetricBatches = await countBatches((batch) => batch.metric_count > 0);
  const hookPayload = JSON.stringify({ transcript_path: rollout });
  const env = {
    ...process.env,
    HOME: home,
    CODEX_HOME: path.join(home, ".codex"),
  };

  const first = await spawnHook(process.execPath, ["src/codex-hook-wrapper.js"], {
    cwd: path.resolve(import.meta.dirname, ".."),
    input: hookPayload,
    env,
  });
  const second = await spawnHook(process.execPath, ["src/codex-hook-wrapper.js"], {
    cwd: path.resolve(import.meta.dirname, ".."),
    input: hookPayload,
    env,
  });

  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(await countBatches((batch) => batch.span_count > 0), beforeTraceBatches + 1);
  assert.equal(await countBatches((batch) => batch.metric_count > 0), beforeMetricBatches + 1);
  assert.match(await readFile(`${rollout}.gtrace`, "utf-8"), /^turn-open\t[0-9a-f]+\n$/);
});

test("Codex parser infers completed status when Stop hook runs before task_complete is written", () => {
  const { turns } = parseSession([
    row("2026-06-03T10:00:00.000Z", "session_meta", {
      id: "sess-stop-before-complete",
      cli_version: "0.139.0",
      model_provider: "openai",
    }),
    row("2026-06-03T10:00:01.000Z", "event_msg", {
      type: "task_started",
      turn_id: "turn-stop-before-complete",
    }),
    row("2026-06-03T10:00:01.100Z", "turn_context", {
      model: "gpt-5.5",
    }),
    row("2026-06-03T10:00:02.000Z", "event_msg", {
      type: "user_message",
      message: "hello",
    }),
    row("2026-06-03T10:00:03.000Z", "event_msg", {
      type: "agent_message",
      message: "done",
    }),
  ]);

  assert.equal(turns.length, 1);
  assert.equal(turns[0].completed, true);
  assert.equal(turns[0].finalOutput, "done");
  assert.equal(turns[0].steps[0].assistantMessages[0].startTime, Date.parse("2026-06-03T10:00:03.000Z"));
  assert.equal(turns[0].steps[0].assistantMessages[0].eventTime, Date.parse("2026-06-03T10:00:03.000Z"));
});

test("Codex parser extends assistant message time to step end without agent_message match", () => {
  const { turns } = parseSession([
    row("2026-06-03T10:00:00.000Z", "session_meta", {
      id: "sess-assistant-time",
      cli_version: "0.139.0",
      model_provider: "openai",
    }),
    row("2026-06-03T10:00:01.000Z", "event_msg", {
      type: "task_started",
      turn_id: "turn-assistant-time",
    }),
    row("2026-06-03T10:00:02.000Z", "response_item", {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "partial answer" }],
    }),
    row("2026-06-03T10:00:02.400Z", "event_msg", {
      type: "token_count",
      info: {
        last_token_usage: {
          input_tokens: 10,
          output_tokens: 3,
          total_tokens: 13,
        },
      },
    }),
  ]);

  assert.equal(turns.length, 1);
  assert.equal(turns[0].steps[0].assistantMessages[0].startTime, Date.parse("2026-06-03T10:00:02.000Z"));
  assert.equal(turns[0].steps[0].assistantMessages[0].endTime, Date.parse("2026-06-03T10:00:02.400Z"));
});

test("Codex parser uses agent_message to update assistant timing without duplicate spans", () => {
  const { turns } = parseSession([
    row("2026-06-03T10:00:00.000Z", "session_meta", {
      id: "sess-assistant-dedupe",
      cli_version: "0.139.0",
      model_provider: "openai",
    }),
    row("2026-06-03T10:00:01.000Z", "event_msg", {
      type: "task_started",
      turn_id: "turn-assistant-dedupe",
    }),
    row("2026-06-03T10:00:02.000Z", "response_item", {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "partial answer" }],
    }),
    row("2026-06-03T10:00:02.250Z", "event_msg", {
      type: "agent_message",
      message: "final answer",
    }),
    row("2026-06-03T10:00:02.400Z", "event_msg", {
      type: "token_count",
      info: {
        last_token_usage: {
          input_tokens: 10,
          output_tokens: 3,
          total_tokens: 13,
        },
      },
    }),
  ]);

  assert.equal(turns.length, 1);
  assert.equal(turns[0].steps.length, 1);
  assert.equal(turns[0].steps[0].assistantMessages.length, 1);
  assert.equal(turns[0].steps[0].assistantMessages[0].text, "final answer");
  assert.equal(turns[0].steps[0].assistantMessages[0].startTime, Date.parse("2026-06-03T10:00:02.000Z"));
  assert.equal(turns[0].steps[0].assistantMessages[0].eventTime, Date.parse("2026-06-03T10:00:02.250Z"));
  assert.equal(turns[0].steps[0].assistantMessages[0].endTime, Date.parse("2026-06-03T10:00:02.250Z"));
});

test("Codex parser collapses multiple assistant response items into one step output", () => {
  const { turns } = parseSession([
    row("2026-06-03T10:00:00.000Z", "session_meta", {
      id: "sess-assistant-collapse",
      cli_version: "0.139.0",
      model_provider: "openai",
    }),
    row("2026-06-03T10:00:01.000Z", "event_msg", {
      type: "task_started",
      turn_id: "turn-assistant-collapse",
    }),
    row("2026-06-03T10:00:02.000Z", "response_item", {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "first part" }],
    }),
    row("2026-06-03T10:00:02.100Z", "response_item", {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "second part" }],
    }),
    row("2026-06-03T10:00:02.300Z", "event_msg", {
      type: "agent_message",
      message: "final combined answer",
    }),
    row("2026-06-03T10:00:02.500Z", "event_msg", {
      type: "token_count",
      info: {
        last_token_usage: {
          input_tokens: 10,
          output_tokens: 3,
          total_tokens: 13,
        },
      },
    }),
  ]);

  assert.equal(turns.length, 1);
  assert.equal(turns[0].steps[0].assistantMessages.length, 1);
  assert.equal(turns[0].steps[0].assistantMessages[0].text, "final combined answer");
  assert.equal(turns[0].steps[0].assistantMessages[0].startTime, Date.parse("2026-06-03T10:00:02.000Z"));
  assert.equal(turns[0].steps[0].assistantMessages[0].eventTime, Date.parse("2026-06-03T10:00:02.300Z"));
  assert.equal(turns[0].steps[0].assistantMessages[0].endTime, Date.parse("2026-06-03T10:00:02.300Z"));
});

test("Codex parser deduplicates repeated tool calls with the same call_id", () => {
  const { turns } = parseSession([
    row("2026-06-03T10:00:00.000Z", "session_meta", {
      id: "sess-tool-dedupe",
      cli_version: "0.140.0",
      model_provider: "openai",
    }),
    row("2026-06-03T10:00:01.000Z", "event_msg", {
      type: "task_started",
      turn_id: "turn-tool-dedupe",
    }),
    row("2026-06-03T10:00:02.000Z", "response_item", {
      type: "function_call",
      name: "exec_command",
      call_id: "call-duplicate",
      arguments: JSON.stringify({ cmd: "npm test" }),
    }),
    row("2026-06-03T10:00:02.001Z", "response_item", {
      type: "function_call",
      name: "exec_command",
      call_id: "call-duplicate",
      arguments: JSON.stringify({ cmd: "npm test" }),
    }),
    row("2026-06-03T10:00:02.300Z", "response_item", {
      type: "function_call_output",
      call_id: "call-duplicate",
      output: "ok",
    }),
    row("2026-06-03T10:00:02.500Z", "event_msg", {
      type: "token_count",
      info: {
        last_token_usage: {
          input_tokens: 10,
          output_tokens: 3,
          total_tokens: 13,
        },
      },
    }),
  ]);

  assert.equal(turns.length, 1);
  assert.equal(turns[0].steps[0].toolCalls.length, 1);
  assert.equal(turns[0].steps[0].toolCalls[0].callId, "call-duplicate");
  assert.deepEqual(turns[0].steps[0].toolCalls[0].args, { cmd: "npm test" });
  assert.equal(turns[0].steps[0].toolCalls[0].endTime, Date.parse("2026-06-03T10:00:02.300Z"));
});

test("Codex collector skips blank turns that only contain startup context", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "gtrace-blank-home-"));
  const rollout = path.join(home, "rollout-blank.jsonl");
  await writeFile(
    rollout,
    `${[
      row("2026-06-03T10:00:00.000Z", "session_meta", {
        id: "019dbfb6-0f6f-7ac1-a8e9-4c50b5973edf",
        cli_version: "0.124.0",
        model_provider: "openai",
      }),
      row("2026-06-03T10:00:01.000Z", "event_msg", {
        type: "task_started",
        turn_id: "turn-blank",
      }),
      row("2026-06-03T10:00:01.100Z", "response_item", {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: "# AGENTS.md instructions for /home/liurui\n\n<INSTRUCTIONS>\nAlways respond in Chinese-simplified\n</INSTRUCTIONS>",
          },
          {
            type: "input_text",
            text: "<environment_context>\n  <cwd>/home/liurui</cwd>\n</environment_context>",
          },
        ],
      }),
      row("2026-06-03T10:00:01.200Z", "turn_context", {
        model: "gpt-5.4",
      }),
      row("2026-06-03T10:00:01.300Z", "event_msg", {
        type: "task_complete",
        turn_id: "turn-blank",
      }),
    ].map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    "utf-8",
  );

  const result = await collectRollout(rollout, { max_chars: 20_000 });

  assert.equal(result.turns.length, 1);
  assert.equal(result.turns[0].userInput, undefined);
  assert.equal(result.spans.length, 0);
  assert.deepEqual(result.uploadedTurnStates, []);
});

async function latestTraceBatch() {
  return latestBatch((batch) => batch.span_count > 0);
}

async function latestMetricsBatch() {
  return latestBatch((batch) => batch.metric_count > 0);
}

async function latestBatch(predicate = () => true) {
  const batchDir = path.join(dataDir, "batches");
  const files = (await readdir(batchDir)).filter((file) => file.endsWith(".json")).sort();
  for (const file of files.reverse()) {
    const batch = JSON.parse(await readFile(path.join(batchDir, file), "utf-8"));
    if (predicate(batch)) return batch;
  }
  throw new Error("no matching batch found");
}

async function countBatches(predicate = () => true) {
  const batchDir = path.join(dataDir, "batches");
  const files = (await readdir(batchDir)).filter((file) => file.endsWith(".json")).sort();
  let count = 0;
  for (const file of files) {
    const batch = JSON.parse(await readFile(path.join(batchDir, file), "utf-8"));
    if (predicate(batch)) count += 1;
  }
  return count;
}

function attrValue(attributes, key) {
  return anyValueToPlain(attributes.find((entry) => entry.key === key)?.value);
}

function anyValueToPlain(value) {
  if (!value) return undefined;
  if (value.stringValue !== undefined) return value.stringValue;
  if (value.boolValue !== undefined) return value.boolValue;
  if (value.intValue !== undefined) return Number(value.intValue);
  if (value.doubleValue !== undefined) return value.doubleValue;
  if (value.arrayValue !== undefined) return value.arrayValue.values.map(anyValueToPlain);
  if (value.kvlistValue !== undefined) {
    return Object.fromEntries(value.kvlistValue.values.map((entry) => [entry.key, anyValueToPlain(entry.value)]));
  }
  return undefined;
}

function spanStartNs(span) {
  return BigInt(span.startTimeUnixNano ?? span.start_time_unix_nano ?? 0);
}

function spanEndNs(span) {
  return BigInt(span.endTimeUnixNano ?? span.end_time_unix_nano ?? 0);
}

function collectOtlpAttributeKeys(request) {
  const keys = [];
  for (const resourceSpan of request.resourceSpans ?? []) {
    keys.push(...(resourceSpan.resource?.attributes ?? []).map((entry) => entry.key));
    for (const scopeSpan of resourceSpan.scopeSpans ?? []) {
      keys.push(...(scopeSpan.scope?.attributes ?? []).map((entry) => entry.key));
      for (const span of scopeSpan.spans ?? []) {
        keys.push(...(span.attributes ?? []).map((entry) => entry.key));
      }
    }
  }
  return keys;
}

function buildTracePayload() {
  const now = 1_800_000_000_000_000_000n;
  const traceId = Buffer.from("00112233445566778899aabbccddeeff", "hex");
  const rootSpanId = Buffer.from("0011223344556677", "hex");
  const generationSpanId = Buffer.from("1111223344556677", "hex");
  const toolSpanId = Buffer.from("2222223344556677", "hex");

  const request = {
    resourceSpans: [
      {
        resource: {
          attributes: [
            attr("service.name", "codex"),
            attr("telemetry.sdk.language", "nodejs"),
          ],
        },
        scopeSpans: [
          {
            scope: { name: "gtrace-otel-test", version: "1.0.0" },
            spans: [
              span({
                traceId,
                spanId: rootSpanId,
                name: "Codex Turn",
                start: now,
                end: now + 100_000_000n,
                attributes: [
                  attr("trace_name", "Codex Turn"),
                  attr("gen_ai.conversation.id", "codex-session-1"),
                  attr("user.id", "user@example.com"),
                  attr("span_type", "agent"),
                  attr("input_preview", "hello"),
                  attr("output_preview", "done"),
                  attr("run_id", "turn-1"),
                ],
              }),
              span({
                traceId,
                spanId: generationSpanId,
                parentSpanId: rootSpanId,
                name: "gpt-test",
                start: now + 10_000_000n,
                end: now + 60_000_000n,
                attributes: [
                  attr("span_type", "llm"),
                  attr("gen_ai.request.model", "gpt-test"),
                  attr("gen_ai.response.model", "gpt-test"),
                  attr("gen_ai.usage.input_tokens", 10),
                  attr("gen_ai.usage.output_tokens", 20),
                  attr("gen_ai.usage.cache_read.input_tokens", 2),
                  attr("gen_ai.usage.reasoning.output_tokens", 3),
                ],
              }),
              span({
                traceId,
                spanId: toolSpanId,
                parentSpanId: generationSpanId,
                name: "exec_command",
                start: now + 70_000_000n,
                end: now + 90_000_000n,
                attributes: [
                  attr("span_type", "tool"),
                  attr("reason", "command failed"),
                ],
                status: { code: 2, message: "command failed" },
              }),
            ],
          },
        ],
      },
    ],
  };

  return encodeExportTraceServiceRequest(request);
}

function span({ traceId, spanId, parentSpanId, name, start, end, attributes, status }) {
  return {
    traceId,
    spanId,
    parentSpanId,
    name,
    kind: 1,
    startTimeUnixNano: start,
    endTimeUnixNano: end,
    attributes,
    status: status ?? { code: 0 },
  };
}

function attr(key, value) {
  return {
    key,
    value:
      typeof value === "boolean"
        ? { boolValue: value }
        : typeof value === "number"
          ? { intValue: value }
          : { stringValue: String(value) },
  };
}

function buildCodexRolloutFixture() {
  const rows = [
    row("2026-06-03T10:00:00.000Z", "session_meta", {
      id: "sess-basic",
      cli_version: "0.123.0",
      model_provider: "openai",
      timestamp: "2026-06-03T09:59:58.000Z",
      source: "cli",
    }),
    row("2026-06-03T10:00:01.000Z", "event_msg", {
      type: "task_started",
      turn_id: "turn-1",
    }),
    row("2026-06-03T10:00:01.100Z", "turn_context", {
      model: "gpt-5.4",
    }),
    row("2026-06-03T10:00:01.200Z", "event_msg", {
      type: "user_message",
      message: "List the files in the repo",
    }),
    row("2026-06-03T10:00:02.000Z", "response_item", {
      type: "reasoning",
      summary: [{ text: "I'll list files with ls." }],
    }),
    row("2026-06-03T10:00:02.100Z", "response_item", {
      type: "function_call",
      name: "exec_command",
      call_id: "call-1",
      arguments: JSON.stringify({ command: ["ls"] }),
    }),
    row("2026-06-03T10:00:02.600Z", "event_msg", {
      type: "token_count",
      info: {
        last_token_usage: {
          input_tokens: 100,
          output_tokens: 20,
          total_tokens: 120,
          cached_input_tokens: 0,
          reasoning_output_tokens: 5,
        },
      },
    }),
    row("2026-06-03T10:00:03.100Z", "event_msg", {
      type: "exec_command_end",
      call_id: "call-1",
      status: "completed",
      stdout: "file1.txt\nfile2.txt",
    }),
    row("2026-06-03T10:00:04.000Z", "response_item", {
      type: "message",
      role: "assistant",
      content: [
        {
          type: "output_text",
          text: "There are two files: file1.txt and file2.txt.",
        },
      ],
    }),
    row("2026-06-03T10:00:04.200Z", "event_msg", {
      type: "token_count",
      info: {
        last_token_usage: {
          input_tokens: 150,
          output_tokens: 30,
          total_tokens: 180,
          cached_input_tokens: 50,
          reasoning_output_tokens: 0,
        },
      },
    }),
    row("2026-06-03T10:00:04.300Z", "event_msg", {
      type: "agent_message",
      message: "There are two files: file1.txt and file2.txt.",
    }),
    row("2026-06-03T10:00:04.400Z", "event_msg", {
      type: "task_complete",
      turn_id: "turn-1",
    }),
  ];
  return `${rows.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}

function row(timestamp, type, payload) {
  return { timestamp, type, payload };
}

async function mkdirp(dir) {
  await import("node:fs/promises").then((fs) => fs.mkdir(dir, { recursive: true }));
}

function spawnHook(command, args, options) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(options.input);
  });
}
