import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { resolveConfig } from "../src/codex-config.js";

test("resolveConfig only reads gtrace.json files and ignores runtime config environment variables", async () => {
  const base = await mkdtemp(path.join(tmpdir(), "gtrace-config-"));
  const home = path.join(base, "home");
  const cwd = path.join(base, "workspace");

  await mkdir(path.join(home, ".codex"), { recursive: true });
  await mkdir(path.join(cwd, ".codex"), { recursive: true });

  await writeFile(
    path.join(home, ".codex", "gtrace.json"),
    JSON.stringify(
      {
        enabled: false,
        endpoint: "http://global.example.com",
        tracePath: "global/traces",
        metricsPath: "global/metrics",
      },
      null,
      2,
    ),
    "utf-8",
  );

  await writeFile(
    path.join(cwd, ".codex", "gtrace.json"),
    JSON.stringify(
      {
        enabled: true,
        endpoint: "http://local.example.com/",
        tracePath: "/local/traces/",
        metricsPath: "/local/metrics/",
        resourceAttributes: {
          app_id: "codex-local",
        },
      },
      null,
      2,
    ),
    "utf-8",
  );

  const previousEndpoint = process.env.GTRACE_ENDPOINT;
  const previousEnabled = process.env.GTRACE_CODEX_ENABLED;
  const previousAttrs = process.env.GTRACE_CODEX_RESOURCE_ATTRIBUTES;

  process.env.GTRACE_ENDPOINT = "http://env.example.com";
  process.env.GTRACE_CODEX_ENABLED = "false";
  process.env.GTRACE_CODEX_RESOURCE_ATTRIBUTES = '{"app_id":"env-app"}';

  try {
    const config = resolveConfig({ home, cwd });

    assert.equal(config.enabled, true);
    assert.equal(config.endpoint, "http://local.example.com");
    assert.equal(config.tracePath, "local/traces");
    assert.equal(config.metricsPath, "local/metrics");
    assert.equal(config.resourceAttributes.app_id, "codex-local");
  } finally {
    restoreEnv("GTRACE_ENDPOINT", previousEndpoint);
    restoreEnv("GTRACE_CODEX_ENABLED", previousEnabled);
    restoreEnv("GTRACE_CODEX_RESOURCE_ATTRIBUTES", previousAttrs);
  }
});

function restoreEnv(key, value) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
