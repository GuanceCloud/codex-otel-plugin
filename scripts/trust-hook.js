import { spawn } from "node:child_process";
import readline from "node:readline";
import { pathToFileURL } from "node:url";

export function gtraceTrustEntries(response) {
  const entries = Array.isArray(response?.data) ? response.data : [];
  const hooks = entries.flatMap((entry) => Array.isArray(entry?.hooks) ? entry.hooks : []);
  return hooks
    .filter((hook) => hook?.source === "user"
      && typeof hook?.command === "string"
      && hook.command.includes("codex-hook-wrapper.js")
      && typeof hook?.key === "string"
      && typeof hook?.currentHash === "string")
    .map((hook) => [hook.key, { trusted_hash: hook.currentHash }]);
}

export async function trustGtraceHook({ codexCommand, cwd = process.cwd(), timeoutMs = 30_000 }) {
  const child = spawn(codexCommand, ["app-server"], { stdio: ["pipe", "pipe", "inherit"] });
  const lines = readline.createInterface({ input: child.stdout });
  const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
  const timer = setTimeout(() => child.kill(), timeoutMs);
  try {
    send({ id: 1, method: "initialize", params: { clientInfo: { name: "gtrace-installer", version: "0.1.14" }, capabilities: {} } });
    for await (const line of lines) {
      const message = JSON.parse(line);
      if (message.id === 1) {
        send({ method: "initialized", params: {} });
        send({ id: 2, method: "hooks/list", params: { cwds: [cwd] } });
      } else if (message.id === 2) {
        const entries = gtraceTrustEntries(message.result);
        if (entries.length === 0) throw new Error("Codex did not discover the GTrace user hook.");
        send({ id: 3, method: "config/batchWrite", params: {
          edits: [{ keyPath: "hooks.state", value: Object.fromEntries(entries), mergeStrategy: "upsert" }],
          filePath: null,
          expectedVersion: null,
          reloadUserConfig: true,
        } });
      } else if (message.id === 3) {
        if (message.error) throw new Error(message.error.message ?? JSON.stringify(message.error));
        return;
      }
    }
    throw new Error("Codex app-server exited before the hook was trusted.");
  } finally {
    clearTimeout(timer);
    child.kill();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const codexCommand = process.argv[2];
  if (!codexCommand) throw new Error("Usage: node scripts/trust-hook.js <codex-command> [cwd]");
  await trustGtraceHook({ codexCommand, cwd: process.argv[3] || process.cwd() });
  process.stdout.write("Trusted the GTrace Codex Stop hook.\n");
}
