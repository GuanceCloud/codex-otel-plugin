import * as fs from "node:fs/promises";

const DEFAULT_LOCK_STALE_MS = 120_000;
const LEGACY_MARKER = "legacy";

export async function loadUploadedTurnStates(rolloutFile) {
  try {
    const data = await fs.readFile(`${rolloutFile}.gtrace`, "utf-8");
    const out = new Map();
    for (const line of data.split("\n").filter(Boolean)) {
      const [turnId, fingerprint] = line.split("\t");
      if (!turnId) continue;
      out.set(turnId, fingerprint || LEGACY_MARKER);
    }
    return out;
  } catch (error) {
    if (error.code === "ENOENT") return new Map();
    throw error;
  }
}

export async function markTurnUploaded(rolloutFile, turnId, fingerprint) {
  try {
    await fs.appendFile(`${rolloutFile}.gtrace`, `${turnId}\t${fingerprint}\n`, "utf-8");
  } catch {
    // Best-effort dedup. A failed sidecar write only risks duplicate upload next time.
  }
}

export function isLegacyTurnState(state) {
  return state === LEGACY_MARKER;
}

export async function acquireRolloutLock(rolloutFile, options = {}) {
  const lockFile = `${rolloutFile}.gtrace.lock`;
  const staleMs = Number.isFinite(options.staleMs) ? options.staleMs : DEFAULT_LOCK_STALE_MS;
  const payload = JSON.stringify({
    pid: process.pid,
    created_at: new Date().toISOString(),
  });

  while (true) {
    try {
      const handle = await fs.open(lockFile, "wx");
      try {
        await handle.writeFile(`${payload}\n`, "utf-8");
      } catch (error) {
        await handle.close().catch(() => {});
        await fs.unlink(lockFile).catch(() => {});
        throw error;
      }
      await handle.close();
      return { lockFile };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;

      let stats;
      try {
        stats = await fs.stat(lockFile);
      } catch (statError) {
        if (statError?.code === "ENOENT") continue;
        throw statError;
      }

      const ageMs = Date.now() - stats.mtimeMs;
      if (Number.isFinite(ageMs) && ageMs > staleMs) {
        try {
          await fs.unlink(lockFile);
          continue;
        } catch (unlinkError) {
          if (unlinkError?.code === "ENOENT") continue;
        }
      }

      return undefined;
    }
  }
}

export async function releaseRolloutLock(lock) {
  if (!lock?.lockFile) return;
  try {
    await fs.unlink(lock.lockFile);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}
