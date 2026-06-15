import * as fs from "node:fs/promises";

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

