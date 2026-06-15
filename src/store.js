import * as fs from "node:fs/promises";
import * as path from "node:path";

export class FileStore {
  constructor(dataDir = "data") {
    this.dataDir = dataDir;
    this.batchDir = path.join(dataDir, "batches");
    this.spansFile = path.join(dataDir, "spans.ndjson");
  }

  async saveBatch({ rawRequest, spans, ingest }) {
    await fs.mkdir(this.batchDir, { recursive: true });
    const id = `${Date.now()}-${process.hrtime.bigint()}`;
    const batchFile = path.join(this.batchDir, `${id}.json`);
    const batch = {
      id,
      received_at: new Date().toISOString(),
      ingest,
      span_count: spans.length,
      raw_request: rawRequest,
      spans,
    };

    await fs.writeFile(batchFile, `${JSON.stringify(batch, null, 2)}\n`, "utf-8");
    if (spans.length > 0) {
      const lines = spans.map((span) => JSON.stringify(span)).join("\n");
      await fs.appendFile(this.spansFile, `${lines}\n`, "utf-8");
    }

    return { id, batchFile, spanCount: spans.length };
  }

  async listSpans(limit = 50) {
    try {
      const data = await fs.readFile(this.spansFile, "utf-8");
      const lines = data.trim().split("\n").filter(Boolean);
      return lines.slice(-limit).map((line) => JSON.parse(line));
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
  }
}

