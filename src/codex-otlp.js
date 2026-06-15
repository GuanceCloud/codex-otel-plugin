function bytesToOtlpJson(value) {
  if (!value) return undefined;
  if (Buffer.isBuffer(value)) return value.toString("base64");
  if (value instanceof Uint8Array) return Buffer.from(value).toString("base64");
  if (typeof value === "string" && /^[0-9a-fA-F]+$/.test(value) && value.length % 2 === 0) {
    return Buffer.from(value, "hex").toString("base64");
  }
  return Buffer.from(String(value), "utf-8").toString("base64");
}

function bytesToOtlpProto(value) {
  if (!value) return undefined;
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === "string" && /^[0-9a-fA-F]+$/.test(value) && value.length % 2 === 0) {
    return Buffer.from(value, "hex");
  }
  return Buffer.from(String(value), "utf-8");
}

function bytesToOtlp(value, format) {
  return format === "protobuf" ? bytesToOtlpProto(value) : bytesToOtlpJson(value);
}

function anyValue(value, format) {
  if (value === undefined || value === null) return { stringValue: "" };
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "boolean") return { boolValue: value };
  if (typeof value === "number") {
    return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value };
  }
  if (typeof value === "bigint") return { intValue: value.toString() };
  if (Array.isArray(value)) return { arrayValue: { values: value.map((entry) => anyValue(entry, format)) } };
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return { bytesValue: bytesToOtlp(value, format) };
  if (typeof value === "object") {
    return {
      kvlistValue: {
        values: Object.entries(value).map(([key, entry]) => ({
          key,
          value: anyValue(entry, format),
        })),
      },
    };
  }
  return { stringValue: String(value) };
}

function attributesToOtlp(attributes = {}, format) {
  return Object.entries(attributes)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => ({ key, value: anyValue(value, format) }));
}

function statusToOtlp(status = {}) {
  const out = {};
  if (status.message) out.message = status.message;
  if (status.code) out.code = status.code;
  return out;
}

function spanToOtlp(span, format) {
  const out = {
    traceId: bytesToOtlp(span.trace_id, format),
    spanId: bytesToOtlp(span.span_id, format),
    name: span.name,
    kind: span.kind ?? "SPAN_KIND_INTERNAL",
    startTimeUnixNano: span.start_time_unix_nano,
    endTimeUnixNano: span.end_time_unix_nano,
    attributes: attributesToOtlp(span.attributes, format),
    status: statusToOtlp(span.status),
  };
  if (span.parent_id) out.parentSpanId = bytesToOtlp(span.parent_id, format);
  if (span.trace_state) out.traceState = span.trace_state;
  return out;
}

function resourceKey(span) {
  return JSON.stringify({
    resource: span.resource ?? {},
    scope: span.scope ?? {},
  });
}

function codexSpansToOtlpRequest(spans = [], format = "json") {
  const groups = new Map();
  for (const span of spans) {
    const key = resourceKey(span);
    if (!groups.has(key)) {
      groups.set(key, {
        resource: span.resource ?? {},
        scope: span.scope ?? {},
        spans: [],
      });
    }
    groups.get(key).spans.push(spanToOtlp(span, format));
  }

  return {
    resourceSpans: Array.from(groups.values()).map((group) => ({
      resource: { attributes: attributesToOtlp(group.resource, format) },
      scopeSpans: [
        {
          scope: {
            name: group.scope.name,
            version: group.scope.version,
            attributes: attributesToOtlp(group.scope.attributes, format),
          },
          spans: group.spans,
        },
      ],
    })),
  };
}

export function codexSpansToOtlpJson(spans = []) {
  return codexSpansToOtlpRequest(spans, "json");
}

export function codexSpansToOtlpProtobufRequest(spans = []) {
  return codexSpansToOtlpRequest(spans, "protobuf");
}
