import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import { createServer } from "../src/server.js";
import { collectRollout } from "../src/codex-collector.js";
import { buildCodexMetrics } from "../src/codex-metrics.js";
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
  const systemSkillFile = path.join(home, ".codex", "skills", ".system", "plugin-creator", "SKILL.md");
  await writeSkillFile(systemSkillFile, {
    name: "plugin-creator",
    description: "Create and scaffold plugin directories for Codex.",
    version: "2.1.0",
  });

  const rollout = path.join(sessionDir, "rollout-basic-main.jsonl");
  await writeFile(rollout, buildCodexRolloutFixture({ systemSkillFile }), "utf-8");
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
  assert.match(await readFile(path.join(home, ".codex", "gtrace-hook.log"), "utf-8"), /hook invoked/);
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
  assert.equal(attrValue(uploadedSpans[0].attributes, "gen_ai.agent.version"), "0.123.0");
  assert.equal(attrValue(uploadedSpans[0].attributes, "gen_ai.operation.name"), "invoke_agent");
  assert.equal(attrValue(uploadedSpans[0].attributes, "gen_ai.output.type"), "json");
  assert.deepEqual(attrValue(uploadedSpans[0].attributes, "gen_ai.response.finish_reasons"), ["stop"]);
  assert.equal(attrValue(uploadedSpans[0].attributes, "gen_ai.request.choice.count"), 2);
  assert.equal(attrValue(uploadedSpans[0].attributes, "gen_ai.request.seed"), 7);
  assert.equal(attrValue(uploadedSpans[0].attributes, "gen_ai.request.temperature"), 0.2);
  assert.equal(attrValue(uploadedSpans[0].attributes, "gen_ai.request.top_p"), 0.9);
  assert.equal(attrValue(uploadedSpans[0].attributes, "gen_ai.request.max_tokens"), 512);
  assert.equal(attrValue(uploadedSpans[0].attributes, "gen_ai.request.presence_penalty"), 0.3);
  assert.equal(attrValue(uploadedSpans[0].attributes, "gen_ai.request.frequency_penalty"), 0.4);
  assert.deepEqual(attrValue(uploadedSpans[0].attributes, "gen_ai.request.stop_sequences"), ["DONE"]);
  assert.deepEqual(attrValue(uploadedSpans[0].attributes, "gen_ai.system_instructions"), [
    { type: "text", content: "You are a file assistant." },
    { type: "text", content: "Keep answers concise." },
  ]);
  assert.deepEqual(attrValue(uploadedSpans[0].attributes, "gen_ai.tool.definitions"), [
    {
      type: "function",
      name: "exec_command",
      description: "Run a shell command",
      parameters: {
        type: "object",
        properties: {
          command: { type: "array", items: { type: "string" } },
        },
      },
    },
  ]);
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
  assert.ok(llmSpans.every((span) => attrValue(span.attributes, "gen_ai.output.type") === "json"));
  const firstLlm = llmSpans.find((span) => attrValue(span.attributes, "step_index") === 0);
  const secondLlm = llmSpans.find((span) => attrValue(span.attributes, "step_index") === 1);
  assert.ok(firstLlm);
  assert.ok(secondLlm);
  assert.equal(attrValue(firstLlm.attributes, "ttft"), 1000);
  assert.equal(attrValue(secondLlm.attributes, "ttft"), 900);
  assert.equal(Number(spanEndNs(firstLlm) - spanStartNs(firstLlm)) / 1_000_000, 2100);
  assert.equal(Number(spanEndNs(secondLlm) - spanStartNs(secondLlm)) / 1_000_000, 1200);
  assert.deepEqual(attrValue(firstLlm.attributes, "gen_ai.response.finish_reasons"), ["tool_call"]);
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
        {
          type: "tool_call",
          name: "exec_command",
          id: "call-1",
          arguments: JSON.stringify({ command: ["sed", "-n", "1,120p", systemSkillFile] }),
        },
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
  assert.deepEqual(attrValue(cachedLlm.attributes, "gen_ai.response.finish_reasons"), ["stop"]);
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
  assert.equal(attrValue(assistantSpan.attributes, "gen_ai.output.type"), "text");
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

  const listed = await fetch(`${baseUrl}/traces?limit=6`).then((res) => res.json());
  assert.deepEqual(
    listed.data.map((span) => span.gtrace.observation.type).sort(),
    ["agent", "assistant", "llm", "llm", "skill", "tool"].sort(),
  );
  const skillSpan = uploadedSpans.find((span) => span.name === "skill:plugin-creator");
  assert.equal(attrValue(skillSpan.attributes, "gen_ai.operation.name"), "skill");
  assert.equal(attrValue(skillSpan.attributes, "skill.name"), "plugin-creator");
  assert.equal(attrValue(skillSpan.attributes, "gen_ai.skill.name"), "plugin-creator");
  assert.equal(attrValue(skillSpan.attributes, "skill.source.type"), "system");
  assert.equal(attrValue(skillSpan.attributes, "gen_ai.skill.source.type"), "system");
  assert.equal(
    attrValue(skillSpan.attributes, "skill.path"),
    systemSkillFile,
  );
  assert.equal(attrValue(skillSpan.attributes, "gen_ai.skill.path"), systemSkillFile);
  assert.equal(attrValue(skillSpan.attributes, "skill.result_status"), "completed");
  assert.equal(attrValue(skillSpan.attributes, "skill_call_id"), "call-1");
  assert.equal(attrValue(skillSpan.attributes, "skill.description"), "Create and scaffold plugin directories for Codex.");
  assert.equal(attrValue(skillSpan.attributes, "gen_ai.skill.result.status"), "completed");
  assert.equal(
    attrValue(skillSpan.attributes, "gen_ai.skill.description"),
    "Create and scaffold plugin directories for Codex.",
  );
  assert.equal(attrValue(skillSpan.attributes, "gen_ai.skill.version"), "2.1.0");
  assert.ok(spanStartNs(skillSpan) >= spanStartNs(firstLlm));
  assert.ok(spanEndNs(skillSpan) <= spanEndNs(firstLlm));
  const toolSpan = uploadedSpans.find((span) => span.name === "tool:exec_command");
  assert.equal(
    attrValue(toolSpan.attributes, "tool_command"),
    `sed -n 1,120p ${systemSkillFile}`,
  );
  assert.equal(attrValue(toolSpan.attributes, "gen_ai.operation.name"), "execute_tool");
  assert.equal(attrValue(toolSpan.attributes, "gen_ai.tool.name"), "exec_command");
  assert.equal(attrValue(toolSpan.attributes, "gen_ai.tool.call.id"), "call-1");
  assert.equal(attrValue(toolSpan.attributes, "skill_call_id"), "call-1");
  assert.equal(attrValue(toolSpan.attributes, "skill.description"), "Create and scaffold plugin directories for Codex.");
  assert.equal(attrValue(toolSpan.attributes, "skill.name"), "plugin-creator");
  assert.equal(attrValue(toolSpan.attributes, "gen_ai.skill.name"), "plugin-creator");
  assert.equal(attrValue(toolSpan.attributes, "skill.source.type"), "system");
  assert.equal(attrValue(toolSpan.attributes, "gen_ai.skill.source.type"), "system");
  assert.equal(attrValue(toolSpan.attributes, "gen_ai.skill.version"), "2.1.0");
  assert.equal(
    attrValue(toolSpan.attributes, "gen_ai.tool.call.arguments"),
    JSON.stringify({ command: ["sed", "-n", "1,120p", systemSkillFile] }),
  );
  assert.equal(attrValue(toolSpan.attributes, "gen_ai.tool.call.result"), "file1.txt file2.txt");
  assert.equal(toolSpan.parent_id, firstLlm.span_id);
  assert.equal(skillSpan.parent_id, toolSpan.span_id);
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
  assert.equal(metricsBatch.metric_count, 12);
  assert.deepEqual(
    Array.from(new Set(metricsBatch.metrics.map((metric) => metric.name))).sort(),
    [
      "gen_ai.agent.operation.count",
      "gen_ai.agent.operation.duration",
      "gen_ai.client.token.usage",
      "gen_ai.workflow.duration",
    ],
  );
  const rawOperationCountMetric = metricsBatch.raw_request.resourceMetrics[0].scopeMetrics[0].metrics.find(
    (metric) => metric.name === "gen_ai.agent.operation.count",
  );
  assert.ok(rawOperationCountMetric?.sum);
  assert.deepEqual(
    rawOperationCountMetric.sum.dataPoints.map((point) => point.asDouble).sort((a, b) => a - b),
    [1, 1, 2],
  );
  assert.ok(rawOperationCountMetric.sum.dataPoints.every((point) => point.asInt === undefined));
  assert.ok(metricsBatch.metrics.every((metric) => metric.attributes["gen_ai.conversation.id"] === "sess-basic"));
  assert.ok(metricsBatch.metrics.every((metric) => metric.attributes.session_key === undefined));
  assert.ok(metricsBatch.metrics.every((metric) => metric.attributes.run_id === undefined));
  assert.ok(metricsBatch.metrics.every((metric) => metric.attributes.session_id === "sess-basic"));
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
  const skillWorkflow = metricsBatch.metrics.find(
    (metric) =>
      metric.name === "gen_ai.workflow.duration" &&
      metric.attributes["skill.name"] === "plugin-creator",
  );
  assert.equal(skillWorkflow, undefined);
  const modelOperation = metricsBatch.metrics.find(
    (metric) =>
      metric.name === "gen_ai.agent.operation.duration" &&
      metric.attributes.operation_name === "model",
  );
  assert.equal(modelOperation.unit, "ms");
  assert.equal(modelOperation.attributes["gen_ai.operation.name"], "chat");
  assert.equal(modelOperation.attributes.provider_name, "openai");
  assert.equal(modelOperation.attributes.request_model, "gpt-5.4");
  assert.equal(modelOperation.attributes.response_model, "gpt-5.4");
  const skillOperation = metricsBatch.metrics.find(
    (metric) =>
      metric.name === "gen_ai.agent.operation.duration" &&
      metric.attributes["gen_ai.operation.name"] === "skill" &&
      metric.attributes.skill_name === "plugin-creator",
  );
  assert.equal(skillOperation.unit, "ms");
  assert.equal(skillOperation.attributes.agent_runtime, "codex");
  assert.equal(skillOperation.attributes.operation_name, "skill");
  assert.equal(skillOperation.attributes.outcome, "completed");
  assert.equal(skillOperation.attributes.skill_name, "plugin-creator");
  assert.equal(skillOperation.attributes.skill_source, "system");
  assert.equal(skillOperation.attributes["gen_ai.skill.name"], "plugin-creator");
  assert.equal(skillOperation.attributes["gen_ai.skill.source.type"], "system");
  assert.equal(skillOperation.attributes["gen_ai.skill.result.status"], "completed");
  assert.equal(skillOperation.attributes["gen_ai.skill.version"], "2.1.0");
  assert.equal(skillOperation.attributes.skill_call_id, undefined);
  const skillOperationCount = metricsBatch.metrics.find(
    (metric) =>
      metric.name === "gen_ai.agent.operation.count" &&
      metric.attributes.operation_name === "skill" &&
      metric.attributes.skill_name === "plugin-creator",
  );
  assert.equal(skillOperationCount.value, 1);
  assert.equal(skillOperationCount.attributes.skill_source, "system");
  const toolOperation = metricsBatch.metrics.find(
    (metric) =>
      metric.name === "gen_ai.agent.operation.duration" &&
      metric.attributes["gen_ai.operation.name"] === "execute_tool",
  );
  assert.equal(toolOperation.unit, "ms");
  assert.equal(toolOperation.attributes.operation_name, "tool");
  assert.equal(toolOperation.attributes.outcome, "completed");
  assert.equal(toolOperation.attributes.tool_name, "exec_command");
  assert.equal(toolOperation.attributes["gen_ai.tool.name"], "exec_command");
  assert.equal(toolOperation.attributes.skill_name, "plugin-creator");
  assert.equal(toolOperation.attributes["gen_ai.skill.name"], "plugin-creator");
  assert.equal(toolOperation.attributes.skill_source, "system");
  assert.equal(toolOperation.attributes.tool_result_status, "completed");
  const toolOperationCount = metricsBatch.metrics.find(
    (metric) =>
      metric.name === "gen_ai.agent.operation.count" &&
      metric.attributes.operation_name === "tool" &&
      metric.attributes.tool_name === "exec_command",
  );
  assert.equal(toolOperationCount.value, 1);
  assert.equal(toolOperationCount.attributes.skill_name, "plugin-creator");

  const listedMetrics = await fetch(`${baseUrl}/metrics?limit=20`).then((res) => res.json());
  assert.ok(listedMetrics.data.some((metric) => metric.name === "gen_ai.client.token.usage"));
  assert.ok(listedMetrics.data.some((metric) => metric.name === "gen_ai.agent.operation.count"));
  assert.ok(listedMetrics.data.some((metric) => metric.name === "gen_ai.agent.operation.duration"));
});

test("native gtrace Codex hook logs stdin failures and keeps exit 0 by default", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "gtrace-hook-empty-stdin-"));
  await mkdirp(path.join(home, ".codex"));
  await writeFile(
    path.join(home, ".codex", "gtrace.json"),
    JSON.stringify(
      {
        enabled: true,
        endpoint: baseUrl,
        tracePath: "api/public/otel/v1/traces",
        metricsPath: "api/public/otel/v1/metrics",
        debug: true,
        hook_log_file: path.join(home, ".codex", "gtrace-hook.log"),
      },
      null,
      2,
    ),
  );

  const result = await spawnHook(process.execPath, ["src/codex-hook-wrapper.js"], {
    cwd: path.resolve(import.meta.dirname, ".."),
    input: "",
    env: {
      ...process.env,
      HOME: home,
      CODEX_HOME: path.join(home, ".codex"),
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /empty hook stdin/);
  const log = await readFile(path.join(home, ".codex", "gtrace-hook.log"), "utf-8");
  assert.match(log, /"message":"failed"/);
  assert.match(log, /empty hook stdin/);
  assert.match(log, /"phase":"runHook"/);
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

test("sequential Codex hooks skip incomplete turns and upload once after completion", async () => {
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
  assert.equal(await countBatches((batch) => batch.span_count > 0), beforeTraceBatches);
  assert.equal(await countBatches((batch) => batch.metric_count > 0), beforeMetricBatches);
  await assert.rejects(stat(`${rollout}.gtrace`), { code: "ENOENT" });

  await appendFile(
    rollout,
    `${[
      row("2026-06-03T10:00:02.300Z", "event_msg", {
        type: "agent_message",
        message: "Current status is healthy.",
      }),
      row("2026-06-03T10:00:02.400Z", "event_msg", {
        type: "task_complete",
      }),
    ].map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    "utf-8",
  );

  const third = await spawnHook(process.execPath, ["src/codex-hook-wrapper.js"], {
    cwd: path.resolve(import.meta.dirname, ".."),
    input: hookPayload,
    env,
  });
  const fourth = await spawnHook(process.execPath, ["src/codex-hook-wrapper.js"], {
    cwd: path.resolve(import.meta.dirname, ".."),
    input: hookPayload,
    env,
  });

  assert.equal(third.status, 0, third.stderr);
  assert.equal(fourth.status, 0, fourth.stderr);
  assert.equal(await countBatches((batch) => batch.span_count > 0), beforeTraceBatches + 1);
  assert.equal(await countBatches((batch) => batch.metric_count > 0), beforeMetricBatches + 1);
  assert.match(await readFile(`${rollout}.gtrace`, "utf-8"), /^turn-open\t[0-9a-f]+\n$/);
});

test("Codex collector does not reupload completed turns after sidecar fingerprint drift", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "gtrace-sidecar-dedupe-"));
  const sessionDir = path.join(home, "sessions");
  await mkdirp(path.join(home, ".codex"));
  await mkdirp(sessionDir);

  const rollout = path.join(sessionDir, "rollout-sidecar-dedupe.jsonl");
  await writeFile(rollout, buildCodexRolloutFixture(), "utf-8");
  await writeFile(`${rollout}.gtrace`, "turn-1\tdeadbeef\n", "utf-8");

  const result = await collectRollout(rollout, { max_chars: 4096 });
  assert.equal(result.turns.length, 1);
  assert.equal(result.spans.length, 0);
  assert.deepEqual(result.uploadedTurnStates, []);
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

test("Codex collector nests skill span under tool span while keeping assistant spans", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "gtrace-skill-order-"));
  const sessionDir = path.join(home, "sessions");
  await mkdirp(path.join(home, ".codex"));
  await mkdirp(sessionDir);
  const userSkillFile = path.join(home, ".codex", "skills", "dashboard", "SKILL.md");
  await writeSkillFile(userSkillFile, {
    name: "dashboard",
    description: "生成观测云 Dashboard 仪表板。",
    version: "1.4.0",
  });

  const rollout = path.join(sessionDir, "rollout-skill-order.jsonl");
  await writeFile(
    rollout,
    `${[
      row("2026-06-03T10:00:00.000Z", "session_meta", {
        id: "sess-skill-order",
        cli_version: "0.140.0",
        model_provider: "openai",
      }),
      row("2026-06-03T10:00:01.000Z", "event_msg", {
        type: "task_started",
        turn_id: "turn-skill-order",
      }),
      row("2026-06-03T10:00:01.100Z", "turn_context", {
        model: "gpt-5.4",
      }),
      row("2026-06-03T10:00:01.200Z", "event_msg", {
        type: "user_message",
        message: "Build a dashboard",
      }),
      row("2026-06-03T10:00:02.000Z", "response_item", {
        type: "message",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: "我先读取 dashboard skill 的说明，然后再继续。",
          },
        ],
      }),
      row("2026-06-03T10:00:02.050Z", "response_item", {
        type: "function_call",
        name: "exec_command",
        call_id: "call-skill-order",
        arguments: JSON.stringify({
          command: ["sed", "-n", "1,80p", userSkillFile],
        }),
      }),
      row("2026-06-03T10:00:02.200Z", "event_msg", {
        type: "token_count",
        info: {
          last_token_usage: {
            input_tokens: 20,
            output_tokens: 6,
            total_tokens: 26,
          },
        },
      }),
      row("2026-06-03T10:00:02.500Z", "event_msg", {
        type: "exec_command_end",
        call_id: "call-skill-order",
        status: "completed",
        stdout: "dashboard skill",
      }),
      row("2026-06-03T10:00:03.000Z", "response_item", {
        type: "message",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: "我已经读完 skill 说明。",
          },
        ],
      }),
      row("2026-06-03T10:00:03.100Z", "event_msg", {
        type: "token_count",
        info: {
          last_token_usage: {
            input_tokens: 30,
            output_tokens: 10,
            total_tokens: 40,
          },
        },
      }),
      row("2026-06-03T10:00:03.200Z", "event_msg", {
        type: "agent_message",
        message: "我已经读完 skill 说明。",
      }),
      row("2026-06-03T10:00:03.300Z", "event_msg", {
        type: "task_complete",
      }),
    ].map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    "utf-8",
  );

  const result = await collectRollout(rollout, { max_chars: 4096 });
  const assistantSpans = result.spans.filter((span) => span.name === "assistant");
  assert.equal(assistantSpans.length, 2);
  assert.equal(assistantSpans[0].attributes.output_preview, "我先读取 dashboard skill 的说明，然后再继续。");
  assert.equal(assistantSpans[1].attributes.output_preview, "我已经读完 skill 说明。");

  const skillSpan = result.spans.find((span) => span.name === "skill:dashboard");
  const toolSpan = result.spans.find((span) => span.name === "tool:exec_command");
  const firstLlm = result.spans.find(
    (span) => span.name === "llm" && span.attributes.step_index === 0,
  );
  assert.ok(skillSpan);
  assert.ok(toolSpan);
  assert.ok(firstLlm);
  assert.equal(toolSpan.parent_id, firstLlm.span_id);
  assert.equal(skillSpan.parent_id, toolSpan.span_id);
  assert.equal(skillSpan.attributes["gen_ai.skill.name"], "dashboard");
  assert.equal(skillSpan.attributes["gen_ai.skill.description"], "生成观测云 Dashboard 仪表板。");
  assert.equal(skillSpan.attributes["gen_ai.skill.version"], "1.4.0");
  assert.equal(skillSpan.attributes["gen_ai.skill.path"], userSkillFile);
  assert.equal(skillSpan.attributes["gen_ai.skill.source.type"], "user");
  assert.equal(skillSpan.attributes["gen_ai.skill.result.status"], "completed");
  assert.equal(skillSpan.attributes.skill_call_id, "call-skill-order");
  assert.equal(skillSpan.attributes["skill.description"], "生成观测云 Dashboard 仪表板。");
  assert.equal(toolSpan.attributes["gen_ai.skill.name"], "dashboard");
  assert.equal(toolSpan.attributes["gen_ai.skill.version"], "1.4.0");
  assert.equal(toolSpan.attributes.skill_call_id, "call-skill-order");
  assert.equal(toolSpan.attributes["skill.description"], "生成观测云 Dashboard 仪表板。");

  const metrics = buildCodexMetrics(result.spans);
  const skillWorkflow = metrics.find(
    (metric) =>
      metric.name === "gen_ai.workflow.duration" &&
      metric.attributes["gen_ai.operation.name"] === "skill" &&
      metric.attributes["skill.name"] === "dashboard",
  );
  const toolOperation = metrics.find(
    (metric) =>
      metric.name === "gen_ai.agent.operation.duration" &&
      metric.attributes["gen_ai.operation.name"] === "execute_tool" &&
      metric.attributes.skill_name === "dashboard",
  );
  const skillOperation = metrics.find(
    (metric) =>
      metric.name === "gen_ai.agent.operation.duration" &&
      metric.attributes["gen_ai.operation.name"] === "skill" &&
      metric.attributes.skill_name === "dashboard",
  );
  const toolOperationCount = metrics.find(
    (metric) =>
      metric.name === "gen_ai.agent.operation.count" &&
      metric.attributes.operation_name === "tool" &&
      metric.attributes.skill_name === "dashboard",
  );
  const skillOperationCount = metrics.find(
    (metric) =>
      metric.name === "gen_ai.agent.operation.count" &&
      metric.attributes.operation_name === "skill" &&
      metric.attributes.skill_name === "dashboard",
  );
  assert.equal(skillWorkflow, undefined);
  assert.ok(skillOperation);
  assert.equal(skillOperation.unit, "ms");
  assert.equal(skillOperation.attributes.operation_name, "skill");
  assert.equal(skillOperation.attributes.skill_name, "dashboard");
  assert.equal(skillOperation.attributes.skill_source, "user");
  assert.equal(skillOperation.attributes.outcome, "completed");
  assert.equal(skillOperation.attributes["gen_ai.skill.name"], "dashboard");
  assert.equal(skillOperation.attributes["gen_ai.skill.source.type"], "user");
  assert.equal(skillOperation.attributes["gen_ai.skill.result.status"], "completed");
  assert.equal(skillOperation.attributes["gen_ai.skill.version"], "1.4.0");
  assert.equal(skillOperation.attributes.skill_call_id, undefined);
  assert.ok(skillOperationCount);
  assert.equal(skillOperationCount.value, 1);
  assert.equal(skillOperationCount.attributes.skill_source, "user");
  assert.ok(toolOperation);
  assert.equal(toolOperation.unit, "ms");
  assert.equal(toolOperation.attributes.operation_name, "tool");
  assert.equal(toolOperation.attributes.tool_name, "exec_command");
  assert.equal(toolOperation.attributes.skill_name, "dashboard");
  assert.equal(toolOperation.attributes.skill_source, "user");
  assert.equal(toolOperation.attributes.outcome, "completed");
  assert.equal(toolOperation.attributes["gen_ai.skill.name"], "dashboard");
  assert.equal(toolOperation.attributes["gen_ai.skill.source.type"], "user");
  assert.equal(toolOperation.attributes["gen_ai.skill.result.status"], "completed");
  assert.equal(toolOperation.attributes["gen_ai.skill.version"], "1.4.0");
  assert.equal(toolOperation.attributes.tool_result_status, "completed");
  assert.ok(toolOperationCount);
  assert.equal(toolOperationCount.value, 1);
  assert.equal(toolOperationCount.attributes.skill_name, "dashboard");
});

test("buildCodexMetrics aggregates operation count within the same turn", () => {
  const spans = [
    {
      name: "llm",
      start_time_unix_nano: "100",
      end_time_unix_nano: "200",
      duration_ms: 100,
      attributes: {
        run_id: "turn-1",
        "gen_ai.conversation.id": "sess-1",
        session_id: "sess-1",
        "gen_ai.operation.name": "chat",
        "gen_ai.provider.name": "openai",
        "gen_ai.request.model": "gpt-5.5",
        "gen_ai.response.model": "gpt-5.5",
      },
      resource: { agent_runtime: "codex" },
      scope: { name: "test", version: "1" },
      status: { code: "STATUS_CODE_UNSET" },
    },
    {
      name: "llm",
      start_time_unix_nano: "210",
      end_time_unix_nano: "310",
      duration_ms: 100,
      attributes: {
        run_id: "turn-1",
        "gen_ai.conversation.id": "sess-1",
        session_id: "sess-1",
        "gen_ai.operation.name": "chat",
        "gen_ai.provider.name": "openai",
        "gen_ai.request.model": "gpt-5.5",
        "gen_ai.response.model": "gpt-5.5",
      },
      resource: { agent_runtime: "codex" },
      scope: { name: "test", version: "1" },
      status: { code: "STATUS_CODE_UNSET" },
    },
    {
      name: "tool:exec_command",
      start_time_unix_nano: "320",
      end_time_unix_nano: "420",
      duration_ms: 100,
      attributes: {
        run_id: "turn-1",
        "gen_ai.conversation.id": "sess-1",
        session_id: "sess-1",
        "gen_ai.operation.name": "execute_tool",
        "gen_ai.provider.name": "openai",
        "gen_ai.request.model": "gpt-5.5",
        "gen_ai.response.model": "gpt-5.5",
        "gen_ai.tool.name": "exec_command",
      },
      resource: { agent_runtime: "codex" },
      scope: { name: "test", version: "1" },
      status: { code: "STATUS_CODE_UNSET" },
    },
    {
      name: "tool:exec_command",
      start_time_unix_nano: "430",
      end_time_unix_nano: "530",
      duration_ms: 100,
      attributes: {
        run_id: "turn-1",
        "gen_ai.conversation.id": "sess-1",
        session_id: "sess-1",
        "gen_ai.operation.name": "execute_tool",
        "gen_ai.provider.name": "openai",
        "gen_ai.request.model": "gpt-5.5",
        "gen_ai.response.model": "gpt-5.5",
        "gen_ai.tool.name": "exec_command",
      },
      resource: { agent_runtime: "codex" },
      scope: { name: "test", version: "1" },
      status: { code: "STATUS_CODE_UNSET" },
    },
    {
      name: "tool:exec_command",
      start_time_unix_nano: "540",
      end_time_unix_nano: "640",
      duration_ms: 100,
      attributes: {
        run_id: "turn-2",
        "gen_ai.conversation.id": "sess-1",
        session_id: "sess-1",
        "gen_ai.operation.name": "execute_tool",
        "gen_ai.provider.name": "openai",
        "gen_ai.request.model": "gpt-5.5",
        "gen_ai.response.model": "gpt-5.5",
        "gen_ai.tool.name": "exec_command",
      },
      resource: { agent_runtime: "codex" },
      scope: { name: "test", version: "1" },
      status: { code: "STATUS_CODE_UNSET" },
    },
  ];

  const metrics = buildCodexMetrics(spans);
  const modelCounts = metrics.filter(
    (metric) => metric.name === "gen_ai.agent.operation.count" && metric.attributes.operation_name === "model",
  );
  const toolCounts = metrics.filter(
    (metric) => metric.name === "gen_ai.agent.operation.count" && metric.attributes.operation_name === "tool",
  );

  assert.equal(modelCounts.length, 1);
  assert.equal(modelCounts[0].value, 2);
  assert.equal(modelCounts[0].start_time_unix_nano, "100");
  assert.equal(modelCounts[0].time_unix_nano, "310");

  assert.equal(toolCounts.length, 2);
  assert.deepEqual(
    toolCounts.map((metric) => metric.value).sort((a, b) => a - b),
    [1, 2],
  );
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

function buildCodexRolloutFixture(options = {}) {
  const systemSkillFile =
    options.systemSkillFile ?? "/home/liurui/.codex/skills/.system/plugin-creator/SKILL.md";
  const rows = [
    row("2026-06-03T10:00:00.000Z", "session_meta", {
      id: "sess-basic",
      cli_version: "0.123.0",
      model_provider: "openai",
      timestamp: "2026-06-03T09:59:58.000Z",
      source: "cli",
      base_instructions: {
        text: "You are a file assistant.",
      },
    }),
    row("2026-06-03T10:00:01.000Z", "event_msg", {
      type: "task_started",
      turn_id: "turn-1",
    }),
    row("2026-06-03T10:00:01.100Z", "turn_context", {
      model: "gpt-5.4",
      response_format: { type: "json_object" },
      n: 2,
      seed: 7,
      temperature: 0.2,
      top_p: 0.9,
      max_output_tokens: 512,
      presence_penalty: 0.3,
      frequency_penalty: 0.4,
      stop_sequences: ["DONE"],
      tools: [
        {
          type: "function",
          name: "exec_command",
          description: "Run a shell command",
          parameters: {
            type: "object",
            properties: {
              command: { type: "array", items: { type: "string" } },
            },
          },
        },
      ],
      collaboration_mode: {
        settings: {
          developer_instructions: "Keep answers concise.",
        },
      },
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
      arguments: JSON.stringify({
        command: ["sed", "-n", "1,120p", systemSkillFile],
      }),
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

async function writeSkillFile(skillFile, fields) {
  await mkdirp(path.dirname(skillFile));
  await writeFile(
    skillFile,
    [
      "---",
      `name: ${fields.name}`,
      `description: ${fields.description}`,
      ...(fields.version ? [`version: ${fields.version}`] : []),
      "---",
      "",
      `# ${fields.name}`,
      "",
      fields.description,
      "",
    ].join("\n"),
    "utf-8",
  );
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
