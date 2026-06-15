import * as fs from "node:fs";

export function readStdin() {
  const trimmed = fs.readFileSync(0, "utf-8").trim();
  if (!trimmed) throw new Error("empty hook stdin");
  try {
    return JSON.parse(trimmed);
  } catch (error) {
    throw new Error(`failed to parse hook stdin: ${error.message}`);
  }
}

export function isPrimitive(value) {
  const t = typeof value;
  return t === "string" || t === "number" || t === "boolean";
}

export function toText(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (isPrimitive(value)) return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function truncate(value, maxChars) {
  if (typeof value !== "string" || value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n...[truncated ${value.length - maxChars} chars]`;
}

export function clipValue(value, maxChars) {
  if (typeof value === "string") return truncate(value, maxChars);
  if (Array.isArray(value)) return value.map((entry) => clipValue(entry, maxChars));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, clipValue(entry, maxChars)]),
    );
  }
  return value;
}
