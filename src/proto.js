const WIRE_VARINT = 0;
const WIRE_FIXED64 = 1;
const WIRE_LENGTH_DELIMITED = 2;
const WIRE_FIXED32 = 5;

const SPAN_KIND_NAMES = {
  0: "SPAN_KIND_UNSPECIFIED",
  1: "SPAN_KIND_INTERNAL",
  2: "SPAN_KIND_SERVER",
  3: "SPAN_KIND_CLIENT",
  4: "SPAN_KIND_PRODUCER",
  5: "SPAN_KIND_CONSUMER",
};

const STATUS_CODE_NAMES = {
  0: "STATUS_CODE_UNSET",
  1: "STATUS_CODE_OK",
  2: "STATUS_CODE_ERROR",
};

const AGGREGATION_TEMPORALITY_NAMES = {
  0: "AGGREGATION_TEMPORALITY_UNSPECIFIED",
  1: "AGGREGATION_TEMPORALITY_DELTA",
  2: "AGGREGATION_TEMPORALITY_CUMULATIVE",
};

export function decodeExportTraceServiceRequest(buffer) {
  return decodeExportTraceRequest(toBuffer(buffer));
}

export function encodeExportTraceServiceRequest(request) {
  return encodeMessage((writer) => {
    for (const resourceSpan of request.resourceSpans ?? []) {
      writer.message(1, encodeResourceSpans(resourceSpan));
    }
  });
}

export function encodeExportTraceServiceResponse(response = {}) {
  return encodeMessage((writer) => {
    if (response.partialSuccess || response.partial_success) {
      writer.message(1, encodePartialSuccess(response.partialSuccess ?? response.partial_success));
    }
  });
}

export function decodeExportMetricsServiceRequest(buffer) {
  return decodeExportMetricsRequest(toBuffer(buffer));
}

export function encodeExportMetricsServiceRequest(request) {
  return encodeMessage((writer) => {
    for (const resourceMetric of request.resourceMetrics ?? []) {
      writer.message(1, encodeResourceMetrics(resourceMetric));
    }
  });
}

export function encodeExportMetricsServiceResponse(response = {}) {
  return encodeMessage((writer) => {
    if (response.partialSuccess || response.partial_success) {
      writer.message(1, encodeMetricsPartialSuccess(response.partialSuccess ?? response.partial_success));
    }
  });
}

function decodeExportTraceRequest(buffer) {
  const out = { resourceSpans: [] };
  readFields(buffer, (field, wire, reader) => {
    if (field === 1 && wire === WIRE_LENGTH_DELIMITED) out.resourceSpans.push(decodeResourceSpans(reader.bytes()));
    else reader.skip(wire);
  });
  return out;
}

function decodeResourceSpans(buffer) {
  const out = { scopeSpans: [] };
  readFields(buffer, (field, wire, reader) => {
    if (field === 1 && wire === WIRE_LENGTH_DELIMITED) out.resource = decodeResource(reader.bytes());
    else if (field === 2 && wire === WIRE_LENGTH_DELIMITED) out.scopeSpans.push(decodeScopeSpans(reader.bytes()));
    else if (field === 3 && wire === WIRE_LENGTH_DELIMITED) out.schemaUrl = reader.string();
    else reader.skip(wire);
  });
  return out;
}

function decodeExportMetricsRequest(buffer) {
  const out = { resourceMetrics: [] };
  readFields(buffer, (field, wire, reader) => {
    if (field === 1 && wire === WIRE_LENGTH_DELIMITED) out.resourceMetrics.push(decodeResourceMetrics(reader.bytes()));
    else reader.skip(wire);
  });
  return out;
}

function decodeResourceMetrics(buffer) {
  const out = { scopeMetrics: [] };
  readFields(buffer, (field, wire, reader) => {
    if (field === 1 && wire === WIRE_LENGTH_DELIMITED) out.resource = decodeResource(reader.bytes());
    else if (field === 2 && wire === WIRE_LENGTH_DELIMITED) out.scopeMetrics.push(decodeScopeMetrics(reader.bytes()));
    else if (field === 3 && wire === WIRE_LENGTH_DELIMITED) out.schemaUrl = reader.string();
    else reader.skip(wire);
  });
  return out;
}

function decodeScopeMetrics(buffer) {
  const out = { metrics: [] };
  readFields(buffer, (field, wire, reader) => {
    if (field === 1 && wire === WIRE_LENGTH_DELIMITED) out.scope = decodeInstrumentationScope(reader.bytes());
    else if (field === 2 && wire === WIRE_LENGTH_DELIMITED) out.metrics.push(decodeMetric(reader.bytes()));
    else if (field === 3 && wire === WIRE_LENGTH_DELIMITED) out.schemaUrl = reader.string();
    else reader.skip(wire);
  });
  return out;
}

function decodeMetric(buffer) {
  const out = {};
  readFields(buffer, (field, wire, reader) => {
    if (field === 1 && wire === WIRE_LENGTH_DELIMITED) out.name = reader.string();
    else if (field === 2 && wire === WIRE_LENGTH_DELIMITED) out.description = reader.string();
    else if (field === 3 && wire === WIRE_LENGTH_DELIMITED) out.unit = reader.string();
    else if (field === 5 && wire === WIRE_LENGTH_DELIMITED) out.gauge = decodeGauge(reader.bytes());
    else if (field === 7 && wire === WIRE_LENGTH_DELIMITED) out.sum = decodeSum(reader.bytes());
    else if (field === 9 && wire === WIRE_LENGTH_DELIMITED) out.histogram = decodeHistogram(reader.bytes());
    else reader.skip(wire);
  });
  return out;
}

function decodeGauge(buffer) {
  const out = { dataPoints: [] };
  readFields(buffer, (field, wire, reader) => {
    if (field === 1 && wire === WIRE_LENGTH_DELIMITED) out.dataPoints.push(decodeNumberDataPoint(reader.bytes()));
    else reader.skip(wire);
  });
  return out;
}

function decodeSum(buffer) {
  const out = { dataPoints: [] };
  readFields(buffer, (field, wire, reader) => {
    if (field === 1 && wire === WIRE_LENGTH_DELIMITED) out.dataPoints.push(decodeNumberDataPoint(reader.bytes()));
    else if (field === 2 && wire === WIRE_VARINT) {
      out.aggregationTemporality =
        AGGREGATION_TEMPORALITY_NAMES[reader.uint32()] ?? "AGGREGATION_TEMPORALITY_UNSPECIFIED";
    } else if (field === 3 && wire === WIRE_VARINT) out.isMonotonic = reader.bool();
    else reader.skip(wire);
  });
  return out;
}

function decodeHistogram(buffer) {
  const out = { dataPoints: [] };
  readFields(buffer, (field, wire, reader) => {
    if (field === 1 && wire === WIRE_LENGTH_DELIMITED) out.dataPoints.push(decodeHistogramDataPoint(reader.bytes()));
    else if (field === 2 && wire === WIRE_VARINT) {
      out.aggregationTemporality =
        AGGREGATION_TEMPORALITY_NAMES[reader.uint32()] ?? "AGGREGATION_TEMPORALITY_UNSPECIFIED";
    } else reader.skip(wire);
  });
  return out;
}

function decodeNumberDataPoint(buffer) {
  const out = { attributes: [] };
  readFields(buffer, (field, wire, reader) => {
    if (field === 2 && wire === WIRE_FIXED64) out.startTimeUnixNano = reader.fixed64().toString();
    else if (field === 3 && wire === WIRE_FIXED64) out.timeUnixNano = reader.fixed64().toString();
    else if (field === 4 && wire === WIRE_FIXED64) out.asDouble = reader.double();
    else if (field === 6 && wire === WIRE_VARINT) out.asInt = reader.int64().toString();
    else if (field === 7 && wire === WIRE_LENGTH_DELIMITED) out.attributes.push(decodeKeyValue(reader.bytes()));
    else if (field === 8 && wire === WIRE_VARINT) out.flags = reader.uint32();
    else reader.skip(wire);
  });
  return out;
}

function decodeHistogramDataPoint(buffer) {
  const out = { attributes: [], bucketCounts: [], explicitBounds: [] };
  readFields(buffer, (field, wire, reader) => {
    if (field === 2 && wire === WIRE_FIXED64) out.startTimeUnixNano = reader.fixed64().toString();
    else if (field === 3 && wire === WIRE_FIXED64) out.timeUnixNano = reader.fixed64().toString();
    else if (field === 4 && wire === WIRE_FIXED64) out.count = reader.fixed64().toString();
    else if (field === 5 && wire === WIRE_FIXED64) out.sum = reader.double();
    else if (field === 6 && wire === WIRE_FIXED64) out.bucketCounts.push(reader.fixed64().toString());
    else if (field === 6 && wire === WIRE_LENGTH_DELIMITED) {
      const packed = new ProtoReader(reader.bytes());
      while (!packed.done()) out.bucketCounts.push(packed.fixed64().toString());
    } else if (field === 7 && wire === WIRE_FIXED64) out.explicitBounds.push(reader.double());
    else if (field === 7 && wire === WIRE_LENGTH_DELIMITED) {
      const packed = new ProtoReader(reader.bytes());
      while (!packed.done()) out.explicitBounds.push(packed.double());
    } else if (field === 9 && wire === WIRE_LENGTH_DELIMITED) out.attributes.push(decodeKeyValue(reader.bytes()));
    else if (field === 10 && wire === WIRE_VARINT) out.flags = reader.uint32();
    else if (field === 11 && wire === WIRE_FIXED64) out.min = reader.double();
    else if (field === 12 && wire === WIRE_FIXED64) out.max = reader.double();
    else reader.skip(wire);
  });
  return out;
}

function decodeResource(buffer) {
  const out = { attributes: [] };
  readFields(buffer, (field, wire, reader) => {
    if (field === 1 && wire === WIRE_LENGTH_DELIMITED) out.attributes.push(decodeKeyValue(reader.bytes()));
    else if (field === 2 && wire === WIRE_VARINT) out.droppedAttributesCount = reader.uint32();
    else reader.skip(wire);
  });
  return out;
}

function decodeScopeSpans(buffer) {
  const out = { spans: [] };
  readFields(buffer, (field, wire, reader) => {
    if (field === 1 && wire === WIRE_LENGTH_DELIMITED) out.scope = decodeInstrumentationScope(reader.bytes());
    else if (field === 2 && wire === WIRE_LENGTH_DELIMITED) out.spans.push(decodeSpan(reader.bytes()));
    else if (field === 3 && wire === WIRE_LENGTH_DELIMITED) out.schemaUrl = reader.string();
    else reader.skip(wire);
  });
  return out;
}

function decodeInstrumentationScope(buffer) {
  const out = { attributes: [] };
  readFields(buffer, (field, wire, reader) => {
    if (field === 1 && wire === WIRE_LENGTH_DELIMITED) out.name = reader.string();
    else if (field === 2 && wire === WIRE_LENGTH_DELIMITED) out.version = reader.string();
    else if (field === 3 && wire === WIRE_LENGTH_DELIMITED) out.attributes.push(decodeKeyValue(reader.bytes()));
    else if (field === 4 && wire === WIRE_VARINT) out.droppedAttributesCount = reader.uint32();
    else reader.skip(wire);
  });
  return out;
}

function decodeSpan(buffer) {
  const out = { attributes: [], events: [], links: [] };
  readFields(buffer, (field, wire, reader) => {
    if (field === 1 && wire === WIRE_LENGTH_DELIMITED) out.traceId = reader.bytes();
    else if (field === 2 && wire === WIRE_LENGTH_DELIMITED) out.spanId = reader.bytes();
    else if (field === 3 && wire === WIRE_LENGTH_DELIMITED) out.traceState = reader.string();
    else if (field === 4 && wire === WIRE_LENGTH_DELIMITED) out.parentSpanId = reader.bytes();
    else if (field === 5 && wire === WIRE_LENGTH_DELIMITED) out.name = reader.string();
    else if (field === 6 && wire === WIRE_VARINT) out.kind = SPAN_KIND_NAMES[reader.uint32()] ?? "SPAN_KIND_UNSPECIFIED";
    else if (field === 7 && wire === WIRE_FIXED64) out.startTimeUnixNano = reader.fixed64().toString();
    else if (field === 8 && wire === WIRE_FIXED64) out.endTimeUnixNano = reader.fixed64().toString();
    else if (field === 9 && wire === WIRE_LENGTH_DELIMITED) out.attributes.push(decodeKeyValue(reader.bytes()));
    else if (field === 10 && wire === WIRE_VARINT) out.droppedAttributesCount = reader.uint32();
    else if (field === 11 && wire === WIRE_LENGTH_DELIMITED) out.events.push(decodeEvent(reader.bytes()));
    else if (field === 12 && wire === WIRE_VARINT) out.droppedEventsCount = reader.uint32();
    else if (field === 13 && wire === WIRE_LENGTH_DELIMITED) out.links.push(decodeLink(reader.bytes()));
    else if (field === 14 && wire === WIRE_VARINT) out.droppedLinksCount = reader.uint32();
    else if (field === 15 && wire === WIRE_LENGTH_DELIMITED) out.status = decodeStatus(reader.bytes());
    else if (field === 16 && wire === WIRE_VARINT) out.flags = reader.uint32();
    else reader.skip(wire);
  });
  return out;
}

function decodeEvent(buffer) {
  const out = { attributes: [] };
  readFields(buffer, (field, wire, reader) => {
    if (field === 1 && wire === WIRE_FIXED64) out.timeUnixNano = reader.fixed64().toString();
    else if (field === 2 && wire === WIRE_LENGTH_DELIMITED) out.name = reader.string();
    else if (field === 3 && wire === WIRE_LENGTH_DELIMITED) out.attributes.push(decodeKeyValue(reader.bytes()));
    else if (field === 4 && wire === WIRE_VARINT) out.droppedAttributesCount = reader.uint32();
    else reader.skip(wire);
  });
  return out;
}

function decodeLink(buffer) {
  const out = { attributes: [] };
  readFields(buffer, (field, wire, reader) => {
    if (field === 1 && wire === WIRE_LENGTH_DELIMITED) out.traceId = reader.bytes();
    else if (field === 2 && wire === WIRE_LENGTH_DELIMITED) out.spanId = reader.bytes();
    else if (field === 3 && wire === WIRE_LENGTH_DELIMITED) out.traceState = reader.string();
    else if (field === 4 && wire === WIRE_LENGTH_DELIMITED) out.attributes.push(decodeKeyValue(reader.bytes()));
    else if (field === 5 && wire === WIRE_VARINT) out.droppedAttributesCount = reader.uint32();
    else if (field === 6 && wire === WIRE_VARINT) out.flags = reader.uint32();
    else reader.skip(wire);
  });
  return out;
}

function decodeStatus(buffer) {
  const out = {};
  readFields(buffer, (field, wire, reader) => {
    if (field === 2 && wire === WIRE_LENGTH_DELIMITED) out.message = reader.string();
    else if (field === 3 && wire === WIRE_VARINT) out.code = STATUS_CODE_NAMES[reader.uint32()] ?? "STATUS_CODE_UNSET";
    else reader.skip(wire);
  });
  return out;
}

function decodeKeyValue(buffer) {
  const out = {};
  readFields(buffer, (field, wire, reader) => {
    if (field === 1 && wire === WIRE_LENGTH_DELIMITED) out.key = reader.string();
    else if (field === 2 && wire === WIRE_LENGTH_DELIMITED) out.value = decodeAnyValue(reader.bytes());
    else reader.skip(wire);
  });
  return out;
}

function decodeAnyValue(buffer) {
  const out = {};
  readFields(buffer, (field, wire, reader) => {
    if (field === 1 && wire === WIRE_LENGTH_DELIMITED) out.stringValue = reader.string();
    else if (field === 2 && wire === WIRE_VARINT) out.boolValue = reader.bool();
    else if (field === 3 && wire === WIRE_VARINT) out.intValue = reader.int64().toString();
    else if (field === 4 && wire === WIRE_FIXED64) out.doubleValue = reader.double();
    else if (field === 5 && wire === WIRE_LENGTH_DELIMITED) out.arrayValue = decodeArrayValue(reader.bytes());
    else if (field === 6 && wire === WIRE_LENGTH_DELIMITED) out.kvlistValue = decodeKeyValueList(reader.bytes());
    else if (field === 7 && wire === WIRE_LENGTH_DELIMITED) out.bytesValue = reader.bytes();
    else reader.skip(wire);
  });
  return out;
}

function decodeArrayValue(buffer) {
  const out = { values: [] };
  readFields(buffer, (field, wire, reader) => {
    if (field === 1 && wire === WIRE_LENGTH_DELIMITED) out.values.push(decodeAnyValue(reader.bytes()));
    else reader.skip(wire);
  });
  return out;
}

function decodeKeyValueList(buffer) {
  const out = { values: [] };
  readFields(buffer, (field, wire, reader) => {
    if (field === 1 && wire === WIRE_LENGTH_DELIMITED) out.values.push(decodeKeyValue(reader.bytes()));
    else reader.skip(wire);
  });
  return out;
}

function encodeResourceSpans(value) {
  return encodeMessage((writer) => {
    if (value.resource) writer.message(1, encodeResource(value.resource));
    for (const item of value.scopeSpans ?? []) writer.message(2, encodeScopeSpans(item));
    writer.string(3, value.schemaUrl);
  });
}

function encodeResource(value) {
  return encodeMessage((writer) => {
    for (const item of value.attributes ?? []) writer.message(1, encodeKeyValue(item));
    writer.uint32(2, value.droppedAttributesCount);
  });
}

function encodeScopeSpans(value) {
  return encodeMessage((writer) => {
    if (value.scope) writer.message(1, encodeInstrumentationScope(value.scope));
    for (const item of value.spans ?? []) writer.message(2, encodeSpan(item));
    writer.string(3, value.schemaUrl);
  });
}

function encodeResourceMetrics(value) {
  return encodeMessage((writer) => {
    if (value.resource) writer.message(1, encodeResource(value.resource));
    for (const item of value.scopeMetrics ?? []) writer.message(2, encodeScopeMetrics(item));
    writer.string(3, value.schemaUrl);
  });
}

function encodeScopeMetrics(value) {
  return encodeMessage((writer) => {
    if (value.scope) writer.message(1, encodeInstrumentationScope(value.scope));
    for (const item of value.metrics ?? []) writer.message(2, encodeMetric(item));
    writer.string(3, value.schemaUrl);
  });
}

function encodeMetric(value) {
  return encodeMessage((writer) => {
    writer.string(1, value.name);
    writer.string(2, value.description);
    writer.string(3, value.unit);
    if (value.gauge) writer.message(5, encodeGauge(value.gauge));
    if (value.sum) writer.message(7, encodeSum(value.sum));
    if (value.histogram) writer.message(9, encodeHistogram(value.histogram));
  });
}

function encodeGauge(value) {
  return encodeMessage((writer) => {
    for (const item of value.dataPoints ?? []) writer.message(1, encodeNumberDataPoint(item));
  });
}

function encodeSum(value) {
  return encodeMessage((writer) => {
    for (const item of value.dataPoints ?? []) writer.message(1, encodeNumberDataPoint(item));
    writer.uint32(2, enumNumber(value.aggregationTemporality, AGGREGATION_TEMPORALITY_NAMES));
    writer.bool(3, value.isMonotonic);
  });
}

function encodeHistogram(value) {
  return encodeMessage((writer) => {
    for (const item of value.dataPoints ?? []) writer.message(1, encodeHistogramDataPoint(item));
    writer.uint32(2, enumNumber(value.aggregationTemporality, AGGREGATION_TEMPORALITY_NAMES));
  });
}

function encodeNumberDataPoint(value) {
  return encodeMessage((writer) => {
    writer.fixed64(2, value.startTimeUnixNano);
    writer.fixed64(3, value.timeUnixNano);
    writer.double(4, value.asDouble);
    writer.int64(6, value.asInt);
    for (const item of value.attributes ?? []) writer.message(7, encodeKeyValue(item));
    writer.uint32(8, value.flags);
  });
}

function encodeHistogramDataPoint(value) {
  return encodeMessage((writer) => {
    writer.fixed64(2, value.startTimeUnixNano);
    writer.fixed64(3, value.timeUnixNano);
    writer.fixed64(4, value.count);
    writer.double(5, value.sum);
    for (const item of value.bucketCounts ?? []) writer.fixed64(6, item);
    for (const item of value.explicitBounds ?? []) writer.double(7, item);
    for (const item of value.attributes ?? []) writer.message(9, encodeKeyValue(item));
    writer.uint32(10, value.flags);
    writer.double(11, value.min);
    writer.double(12, value.max);
  });
}

function encodeInstrumentationScope(value) {
  return encodeMessage((writer) => {
    writer.string(1, value.name);
    writer.string(2, value.version);
    for (const item of value.attributes ?? []) writer.message(3, encodeKeyValue(item));
    writer.uint32(4, value.droppedAttributesCount);
  });
}

function encodeSpan(value) {
  return encodeMessage((writer) => {
    writer.bytes(1, value.traceId);
    writer.bytes(2, value.spanId);
    writer.string(3, value.traceState);
    writer.bytes(4, value.parentSpanId);
    writer.string(5, value.name);
    writer.uint32(6, enumNumber(value.kind, SPAN_KIND_NAMES));
    writer.fixed64(7, value.startTimeUnixNano);
    writer.fixed64(8, value.endTimeUnixNano);
    for (const item of value.attributes ?? []) writer.message(9, encodeKeyValue(item));
    writer.uint32(10, value.droppedAttributesCount);
    for (const item of value.events ?? []) writer.message(11, encodeEvent(item));
    writer.uint32(12, value.droppedEventsCount);
    for (const item of value.links ?? []) writer.message(13, encodeLink(item));
    writer.uint32(14, value.droppedLinksCount);
    if (value.status) writer.message(15, encodeStatus(value.status));
    writer.uint32(16, value.flags);
  });
}

function encodeEvent(value) {
  return encodeMessage((writer) => {
    writer.fixed64(1, value.timeUnixNano);
    writer.string(2, value.name);
    for (const item of value.attributes ?? []) writer.message(3, encodeKeyValue(item));
    writer.uint32(4, value.droppedAttributesCount);
  });
}

function encodeLink(value) {
  return encodeMessage((writer) => {
    writer.bytes(1, value.traceId);
    writer.bytes(2, value.spanId);
    writer.string(3, value.traceState);
    for (const item of value.attributes ?? []) writer.message(4, encodeKeyValue(item));
    writer.uint32(5, value.droppedAttributesCount);
    writer.uint32(6, value.flags);
  });
}

function encodeStatus(value) {
  return encodeMessage((writer) => {
    writer.string(2, value.message);
    writer.uint32(3, enumNumber(value.code, STATUS_CODE_NAMES));
  });
}

function encodeKeyValue(value) {
  return encodeMessage((writer) => {
    writer.string(1, value.key);
    if (value.value) writer.message(2, encodeAnyValue(value.value));
  });
}

function encodeAnyValue(value) {
  return encodeMessage((writer) => {
    if (value.stringValue !== undefined) writer.string(1, value.stringValue);
    else if (value.boolValue !== undefined) writer.bool(2, value.boolValue);
    else if (value.intValue !== undefined) writer.int64(3, value.intValue);
    else if (value.doubleValue !== undefined) writer.double(4, value.doubleValue);
    else if (value.arrayValue !== undefined) writer.message(5, encodeArrayValue(value.arrayValue));
    else if (value.kvlistValue !== undefined) writer.message(6, encodeKeyValueList(value.kvlistValue));
    else if (value.bytesValue !== undefined) writer.bytes(7, value.bytesValue);
  });
}

function encodeArrayValue(value) {
  return encodeMessage((writer) => {
    for (const item of value.values ?? []) writer.message(1, encodeAnyValue(item));
  });
}

function encodeKeyValueList(value) {
  return encodeMessage((writer) => {
    for (const item of value.values ?? []) writer.message(1, encodeKeyValue(item));
  });
}

function encodePartialSuccess(value) {
  return encodeMessage((writer) => {
    writer.int64(1, value.rejectedSpans ?? value.rejected_spans);
    writer.string(2, value.errorMessage ?? value.error_message);
  });
}

function encodeMetricsPartialSuccess(value) {
  return encodeMessage((writer) => {
    writer.int64(1, value.rejectedDataPoints ?? value.rejected_data_points);
    writer.string(2, value.errorMessage ?? value.error_message);
  });
}

function readFields(buffer, onField) {
  const reader = new ProtoReader(buffer);
  while (!reader.done()) {
    const tag = reader.uint32();
    onField(tag >>> 3, tag & 7, reader);
  }
}

class ProtoReader {
  constructor(buffer) {
    this.buffer = toBuffer(buffer);
    this.offset = 0;
  }

  done() {
    return this.offset >= this.buffer.length;
  }

  uint32() {
    return Number(this.uint64());
  }

  int64() {
    return signedInt64(this.uint64());
  }

  uint64() {
    let result = 0n;
    let shift = 0n;
    while (this.offset < this.buffer.length) {
      const byte = this.buffer[this.offset++];
      result |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return result;
      shift += 7n;
    }
    throw new Error("truncated protobuf varint");
  }

  fixed64() {
    this.require(8);
    const value = this.buffer.readBigUInt64LE(this.offset);
    this.offset += 8;
    return value;
  }

  double() {
    this.require(8);
    const value = this.buffer.readDoubleLE(this.offset);
    this.offset += 8;
    return value;
  }

  bool() {
    return this.uint64() !== 0n;
  }

  string() {
    return this.bytes().toString("utf-8");
  }

  bytes() {
    const length = this.uint32();
    this.require(length);
    const value = this.buffer.subarray(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }

  skip(wire) {
    if (wire === WIRE_VARINT) this.uint64();
    else if (wire === WIRE_FIXED64) {
      this.require(8);
      this.offset += 8;
    } else if (wire === WIRE_LENGTH_DELIMITED) {
      const length = this.uint32();
      this.require(length);
      this.offset += length;
    } else if (wire === WIRE_FIXED32) {
      this.require(4);
      this.offset += 4;
    } else {
      throw new Error(`unsupported protobuf wire type: ${wire}`);
    }
  }

  require(length) {
    if (this.offset + length > this.buffer.length) throw new Error("truncated protobuf field");
  }
}

class ProtoWriter {
  constructor() {
    this.chunks = [];
  }

  uint32(field, value) {
    if (value === undefined || value === null) return;
    this.tag(field, WIRE_VARINT);
    this.rawVarint(value);
  }

  int64(field, value) {
    if (value === undefined || value === null) return;
    this.tag(field, WIRE_VARINT);
    this.rawVarint(value);
  }

  bool(field, value) {
    if (value === undefined || value === null) return;
    this.uint32(field, value ? 1 : 0);
  }

  fixed64(field, value) {
    if (value === undefined || value === null) return;
    const bytes = Buffer.alloc(8);
    bytes.writeBigUInt64LE(BigInt(value));
    this.tag(field, WIRE_FIXED64);
    this.chunks.push(bytes);
  }

  double(field, value) {
    if (value === undefined || value === null) return;
    const bytes = Buffer.alloc(8);
    bytes.writeDoubleLE(Number(value));
    this.tag(field, WIRE_FIXED64);
    this.chunks.push(bytes);
  }

  string(field, value) {
    if (value === undefined || value === null) return;
    this.bytes(field, Buffer.from(String(value), "utf-8"));
  }

  bytes(field, value) {
    if (value === undefined || value === null) return;
    const buffer = toBuffer(value);
    this.tag(field, WIRE_LENGTH_DELIMITED);
    this.rawVarint(buffer.length);
    this.chunks.push(buffer);
  }

  message(field, value) {
    if (value === undefined || value === null) return;
    this.bytes(field, value);
  }

  tag(field, wire) {
    this.rawVarint((field << 3) | wire);
  }

  rawVarint(value) {
    let current = toUnsignedVarint(value);
    while (current >= 0x80n) {
      this.chunks.push(Buffer.from([Number((current & 0x7fn) | 0x80n)]));
      current >>= 7n;
    }
    this.chunks.push(Buffer.from([Number(current)]));
  }

  finish() {
    return Buffer.concat(this.chunks);
  }
}

function encodeMessage(callback) {
  const writer = new ProtoWriter();
  callback(writer);
  return writer.finish();
}

function toBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  return Buffer.from(value ?? []);
}

function enumNumber(value, names) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "number") return value;
  for (const [number, name] of Object.entries(names)) {
    if (name === value) return Number(number);
  }
  return Number(value);
}

function signedInt64(value) {
  return value >= 0x8000_0000_0000_0000n ? value - 0x1_0000_0000_0000_0000n : value;
}

function toUnsignedVarint(value) {
  const current = BigInt(value);
  return current < 0n ? current + 0x1_0000_0000_0000_0000n : current;
}
