import * as fs from "node:fs/promises";

const DEFAULT_LOCK_STALE_MS = 120_000;

export async function loadUploadedTurnIds(rolloutFile) {
  try {
    const data = await fs.readFile(`${rolloutFile}.gtrace`, "utf-8");
    return new Set(data.split("\n").filter(Boolean));
  } catch (error) {
    if (error.code === "ENOENT") return new Set();
    throw error;
  }
}

export async function markTurnUploaded(rolloutFile, turnId) {
  try {
    await fs.appendFile(`${rolloutFile}.gtrace`, `${turnId}\n`, "utf-8");
  } catch {
    // Best-effort dedup. A failed sidecar write only risks duplicate upload next time.
  }
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
