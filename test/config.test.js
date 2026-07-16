import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { resolveConfig } from "../src/codex-config.js";
import { runHook } from "../src/codex-hook-wrapper.js";
import { writeGtraceConfig } from "../scripts/install-config.js";

test("resolveConfig only reads gtrace.json files and ignores runtime config environment variables", async () => {
  const base = await mkdtemp(path.join(tmpdir(), "gtrace-config-"));
  const home = path.join(base, "home");
  const cwd = path.join(base, "workspace");

  await mkdir(path.join(home, ".codex"), { recursive: true });
  await mkdir(path.join(cwd, ".codex"), { recursive: true });

  await writeFile(
    path.join(home, ".codex", "gtrace.json"),
    `\uFEFF${JSON.stringify(
      {
        enabled: false,
        endpoint: "http://global.example.com",
        tracePath: "global/traces",
        metricsPath: "global/metrics",
        timeout_ms: 12345,
      },
      null,
      2,
    )}`,
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
    assert.equal(config.timeout_ms, 12345);
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

test("installer config preserves enabled and only changes it when explicitly requested", async () => {
  const base = await mkdtemp(path.join(tmpdir(), "gtrace-installer-config-"));
  const configFile = path.join(base, "gtrace.json");
  await writeFile(configFile, '{"enabled":false,"endpoint":"http://example.com"}\n', "utf-8");

  writeGtraceConfig({ configFile, installType: "gtrace" });
  assert.equal(JSON.parse(await readFile(configFile, "utf-8")).enabled, false);

  writeGtraceConfig({ configFile, installType: "gtrace", scriptEnabled: true });
  assert.equal(JSON.parse(await readFile(configFile, "utf-8")).enabled, true);

  writeGtraceConfig({ configFile, installType: "gtrace", scriptEnabled: false });
  assert.equal(JSON.parse(await readFile(configFile, "utf-8")).enabled, false);
});

test("disabled hook exits before reading stdin or transcript", async () => {
  const base = await mkdtemp(path.join(tmpdir(), "gtrace-disabled-hook-"));
  const logFile = path.join(base, "gtrace-hook.log");
  let readAttempted = false;

  await runHook({
    config: { enabled: false, hook_log_file: logFile },
    readHookInput() {
      readAttempted = true;
      throw new Error("stdin should not be read");
    },
  });

  assert.equal(readAttempted, false);
  assert.match(await readFile(logFile, "utf-8"), /gtrace disabled/);
});

test("PowerShell installer avoids node eval when resolving versions", async () => {
  const installer = await readFile(
    new URL("../scripts/install.ps1", import.meta.url),
    "utf-8",
  );

  assert.doesNotMatch(installer, /&\s+\$NodeBin\s+-(?:e|p)\b/);
  assert.match(installer, /&\s+\$NodeBin\s+--version/);
  assert.match(installer, /Get-Content[^\r\n]+PackageJsonPath[^\r\n]*\|\s*ConvertFrom-Json/);
});
