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

const CLIENT_DURATION_BOUNDS = [0.01, 0.02, 0.04, 0.08, 0.16, 0.32, 0.64, 1.28, 2.56, 5.12, 10.24, 20.48, 40.96, 81.92];
const WORKFLOW_DURATION_BOUNDS = [1, 5, 10, 30, 60, 120, 300, 600, 1800, 3600, 7200];
const TOKEN_BOUNDS = [1, 4, 16, 64, 256, 1024, 4096, 16384, 65536, 262144, 1048576, 4194304, 16777216, 67108864];

function metricKey(metric) {
  return JSON.stringify({
    name: metric.name,
    type: metric.type,
    unit: metric.unit,
    description: metric.description,
  });
}

function metricBounds(metric) {
  if (metric.unit === "{token}") return TOKEN_BOUNDS;
  if (metric.name === "gen_ai.workflow.duration") return WORKFLOW_DURATION_BOUNDS;
  if (metric.unit === "s") return CLIENT_DURATION_BOUNDS;
  return [];
}

function histogramDataPoint(metric, format) {
  const value = Number(metric.value);
  const bounds = metricBounds(metric);
  const bucketCounts = Array.from({ length: bounds.length + 1 }, () => "0");
  let bucketIndex = bounds.findIndex((bound) => value <= bound);
  if (bucketIndex < 0) bucketIndex = bounds.length;
  bucketCounts[bucketIndex] = "1";
  return {
    attributes: attributesToOtlp(metric.attributes, format),
    startTimeUnixNano: metric.start_time_unix_nano,
    timeUnixNano: metric.time_unix_nano,
    count: "1",
    sum: value,
    bucketCounts,
    explicitBounds: bounds,
    min: value,
    max: value,
  };
}

function numberDataPoint(metric, format) {
  const value = Number(metric.value);
  return {
    attributes: attributesToOtlp(metric.attributes, format),
    startTimeUnixNano: metric.start_time_unix_nano,
    timeUnixNano: metric.time_unix_nano,
    asInt: Number.isInteger(value) ? String(value) : undefined,
    asDouble: Number.isInteger(value) ? undefined : value,
  };
}

function codexMetricToOtlp(metric, format) {
  const out = {
    name: metric.name,
    description: metric.description,
    unit: metric.unit,
  };
  if (metric.type === "sum") {
    out.sum = {
      dataPoints: [numberDataPoint(metric, format)],
      aggregationTemporality: "AGGREGATION_TEMPORALITY_DELTA",
      isMonotonic: true,
    };
  } else if (metric.type === "histogram") {
    out.histogram = {
      dataPoints: [histogramDataPoint(metric, format)],
      aggregationTemporality: "AGGREGATION_TEMPORALITY_DELTA",
    };
  }
  return out;
}

function codexMetricsToOtlpRequest(metrics = [], format = "json") {
  const resourceGroups = new Map();
  for (const metric of metrics) {
    const resourceGroupKey = JSON.stringify({
      resource: metric.resource ?? {},
      scope: metric.scope ?? {},
    });
    if (!resourceGroups.has(resourceGroupKey)) {
      resourceGroups.set(resourceGroupKey, {
        resource: metric.resource ?? {},
        scope: metric.scope ?? {},
        metricGroups: new Map(),
      });
    }
    const resourceGroup = resourceGroups.get(resourceGroupKey);
    const key = metricKey(metric);
    if (!resourceGroup.metricGroups.has(key)) {
      resourceGroup.metricGroups.set(key, codexMetricToOtlp(metric, format));
    } else {
      const existing = resourceGroup.metricGroups.get(key);
      const next = codexMetricToOtlp(metric, format);
      if (existing.sum && next.sum) existing.sum.dataPoints.push(...next.sum.dataPoints);
      if (existing.histogram && next.histogram) {
        existing.histogram.dataPoints.push(...next.histogram.dataPoints);
      }
    }
  }

  return {
    resourceMetrics: Array.from(resourceGroups.values()).map((group) => ({
      resource: { attributes: attributesToOtlp(group.resource, format) },
      scopeMetrics: [
        {
          scope: {
            name: group.scope.name,
            version: group.scope.version,
            attributes: attributesToOtlp(group.scope.attributes, format),
          },
          metrics: Array.from(group.metricGroups.values()),
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

export function codexMetricsToOtlpJson(metrics = []) {
  return codexMetricsToOtlpRequest(metrics, "json");
}

export function codexMetricsToOtlpProtobufRequest(metrics = []) {
  return codexMetricsToOtlpRequest(metrics, "protobuf");
}
