// OTLP/HTTP の JSON（ログとトレース）から、エラーイベントとエラーを含むトレースだけを取り出す
// （技術定義書 2章「OTLP受信口」、段階3）。
//
// Cloudflare の OTLP エクスポートは protobuf を使わない（公式ドキュメント）ので JSON だけを扱う。
// 属性名は公式ドキュメントにあるもの（service.name、cloudflare.script_name、cloudflare.ray_id、
// cloudflare.outcome など）を使い、例外の表し方は OpenTelemetry の意味規約（exception.*）に従う。
// 実データの形が違ったときに直しやすいよう、属性名はこのファイルの定数にまとめる。
import type { AttrValue, SpanRecord, SpanStatus } from "../../shared/types";

/** Worker 名を表す属性。前にあるものを優先する */
export const WORKER_NAME_KEYS = ["cloudflare.script_name", "service.name", "faas.name"];
export const RAY_ID_KEYS = ["cloudflare.ray_id", "cloudflare.ray", "cf.ray_id", "ray_id"];
const OUTCOME_KEY = "cloudflare.outcome";
/** cloudflare.outcome のうち、エラーとして扱わないもの */
const NON_ERROR_OUTCOMES = new Set([
  "ok",
  "canceled",
  "clientDisconnected",
  "responseStreamDisconnected",
]);

const MAX_ATTRS = 40;
const MAX_ATTR_VALUE = 500;
const MAX_EVENTS = 500;
const MAX_SPANS_PER_TRACE = 1000;
const SEVERITY_ERROR = 17;

/** Queue に積む、Worker 由来のエラーイベント */
export type WorkerEvent = {
  worker: string;
  ts: number;
  type: string;
  message: string;
  stack?: string;
  origin: "log" | "span";
  traceId?: string;
  spanId?: string;
  rayId?: string;
  request?: { url?: string; method?: string; status?: number };
  attributes?: Record<string, AttrValue>;
};

/** Queue に積む、エラーを含むトレース */
export type TraceRecord = {
  traceId: string;
  worker: string;
  rayId?: string;
  spans: SpanRecord[];
};

export type Extracted = { events: WorkerEvent[]; traces: TraceRecord[] };

// ---------------------------------------------------------------- OTLP JSON の値

type KeyValue = { key?: unknown; value?: unknown };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/** AnyValue を JavaScript の値にする。配列と kvlist は JSON 文字列にする */
export function anyValue(v: unknown): AttrValue | undefined {
  if (!isRecord(v)) return undefined;
  if (typeof v.stringValue === "string") return v.stringValue;
  if (typeof v.boolValue === "boolean") return v.boolValue;
  if (v.intValue !== undefined) {
    const n = Number(v.intValue);
    return Number.isFinite(n) ? n : String(v.intValue);
  }
  if (v.doubleValue !== undefined) {
    const n = Number(v.doubleValue);
    return Number.isFinite(n) ? n : undefined;
  }
  if (isRecord(v.arrayValue)) {
    return JSON.stringify(arr(v.arrayValue.values).map(anyValue));
  }
  if (isRecord(v.kvlistValue)) {
    return JSON.stringify(attributes(v.kvlistValue.values, Number.POSITIVE_INFINITY));
  }
  return undefined;
}

export function attributes(list: unknown, max = MAX_ATTRS): Record<string, AttrValue> {
  const out: Record<string, AttrValue> = {};
  let n = 0;
  for (const item of arr(list) as KeyValue[]) {
    if (!isRecord(item) || typeof item.key !== "string") continue;
    const value = anyValue(item.value);
    if (value === undefined) continue;
    out[item.key] = typeof value === "string" ? value.slice(0, MAX_ATTR_VALUE) : value;
    if (++n >= max) break;
  }
  return out;
}

/** 本文用。属性と違って長さを削らない（あとで正規化のときに上限をかける） */
function bodyText(v: unknown): string | undefined {
  if (!isRecord(v)) return undefined;
  if (typeof v.stringValue === "string") return v.stringValue;
  if (isRecord(v.arrayValue)) {
    // console.error("a", err) のような複数の引数は空白でつなぐ
    return arr(v.arrayValue.values)
      .map((x) => (isRecord(x) && typeof x.stringValue === "string" ? x.stringValue : anyValue(x)))
      .filter((x) => x !== undefined)
      .join(" ");
  }
  const value = anyValue(v);
  return value === undefined ? undefined : String(value);
}

/** timeUnixNano（文字列か数値）を UNIX ミリ秒にする */
export function nanosToMs(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return Math.floor(v / 1e6);
  if (typeof v === "string" && /^\d+$/.test(v)) {
    // 2^53 を超えるので、下6桁を落としてから数値にする
    return v.length > 6 ? Number(v.slice(0, -6)) : 0;
  }
  return undefined;
}

/** JSON 版の OTLP ではトレースIDとスパンIDは16進数の文字列 */
function hexId(v: unknown, length: number): string | undefined {
  if (typeof v !== "string") return undefined;
  const id = v.toLowerCase();
  if (id.length !== length || !/^[0-9a-f]+$/.test(id) || /^0+$/.test(id)) return undefined;
  return id;
}

function str(v: AttrValue | undefined): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

function pick(attrs: Record<string, AttrValue>, keys: readonly string[]): string | undefined {
  for (const k of keys) {
    const v = attrs[k];
    if (v !== undefined && v !== "") return String(v);
  }
  return undefined;
}

function workerNameOf(
  resource: Record<string, AttrValue>,
  own: Record<string, AttrValue>,
  fallback: string | undefined,
): string {
  return (pick(resource, WORKER_NAME_KEYS) ?? pick(own, WORKER_NAME_KEYS) ?? fallback ?? "unknown")
    .slice(0, 100)
    .trim();
}

function severityNumber(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    if (/^\d+$/.test(v)) return Number(v);
    // "SEVERITY_NUMBER_ERROR" のような列挙名
    if (/FATAL/.test(v)) return 21;
    if (/ERROR/.test(v)) return SEVERITY_ERROR;
  }
  return 0;
}

function statusOf(v: unknown): { status: SpanStatus; message?: string } {
  if (!isRecord(v)) return { status: "unset" };
  const code = v.code;
  const status: SpanStatus =
    code === 2 || code === "2" || code === "STATUS_CODE_ERROR"
      ? "error"
      : code === 1 || code === "1" || code === "STATUS_CODE_OK"
        ? "ok"
        : "unset";
  return { status, message: typeof v.message === "string" && v.message ? v.message : undefined };
}

function hasException(attrs: Record<string, AttrValue>): boolean {
  return (
    attrs["exception.type"] !== undefined ||
    attrs["exception.message"] !== undefined ||
    attrs["exception.stacktrace"] !== undefined
  );
}

/** 例外の属性を除いた付帯情報（イベント本体の extra に入れる） */
function extraAttributes(attrs: Record<string, AttrValue>): Record<string, AttrValue> | undefined {
  const out: Record<string, AttrValue> = {};
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith("exception.")) continue;
    out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function requestOf(attrs: Record<string, AttrValue>): WorkerEvent["request"] {
  const url = str(attrs["url.full"]) ?? str(attrs["http.url"]) ?? str(attrs["url.path"]);
  const method = str(attrs["http.request.method"]) ?? str(attrs["http.method"]);
  const statusRaw = attrs["http.response.status_code"] ?? attrs["http.status_code"];
  const status = typeof statusRaw === "number" ? statusRaw : Number(statusRaw) || undefined;
  if (!url && !method && !status) return undefined;
  return { url, method, status };
}

// ---------------------------------------------------------------- ログ

/**
 * 重大度が ERROR 以上のログと、例外の属性を持つログをエラーイベントにする。
 * それ以外のログは捨てる（Queue のオペレーション数と保存量を抑えるため）。
 */
export function extractLogs(body: unknown, fallbackWorker?: string): WorkerEvent[] {
  const events: WorkerEvent[] = [];
  if (!isRecord(body)) return events;
  for (const rl of arr(body.resourceLogs)) {
    if (!isRecord(rl)) continue;
    const resource = attributes(isRecord(rl.resource) ? rl.resource.attributes : undefined);
    for (const sl of arr(rl.scopeLogs)) {
      if (!isRecord(sl)) continue;
      for (const rec of arr(sl.logRecords)) {
        if (!isRecord(rec)) continue;
        const attrs = attributes(rec.attributes);
        const sev = severityNumber(rec.severityNumber);
        const sevText = typeof rec.severityText === "string" ? rec.severityText : "";
        const isError =
          sev >= SEVERITY_ERROR || /^(error|fatal|critical)$/i.test(sevText) || hasException(attrs);
        if (!isError) continue;

        const text = bodyText(rec.body);
        const type = str(attrs["exception.type"]) ?? "LogError";
        const message = str(attrs["exception.message"]) ?? text ?? sevText ?? "";
        const stack = str(attrs["exception.stacktrace"]);
        if (!message && !stack) continue;

        events.push({
          worker: workerNameOf(resource, attrs, fallbackWorker),
          ts: nanosToMs(rec.timeUnixNano) ?? nanosToMs(rec.observedTimeUnixNano) ?? Date.now(),
          type,
          message,
          stack,
          origin: "log",
          traceId: hexId(rec.traceId, 32),
          spanId: hexId(rec.spanId, 16),
          rayId: pick(attrs, RAY_ID_KEYS) ?? pick(resource, RAY_ID_KEYS),
          request: requestOf(attrs),
          attributes: extraAttributes(attrs),
        });
        if (events.length >= MAX_EVENTS) return events;
      }
    }
  }
  return events;
}

// ---------------------------------------------------------------- トレース

type RawSpan = SpanRecord & {
  traceId: string;
  worker: string;
  resource: Record<string, AttrValue>;
};

function parseSpan(
  raw: Record<string, unknown>,
  resource: Record<string, AttrValue>,
  fallbackWorker: string | undefined,
): RawSpan | null {
  const traceId = hexId(raw.traceId, 32);
  const spanId = hexId(raw.spanId, 16);
  if (!traceId || !spanId) return null;
  const attrs = attributes(raw.attributes);
  const start = nanosToMs(raw.startTimeUnixNano) ?? Date.now();
  const end = nanosToMs(raw.endTimeUnixNano) ?? start;
  const { status, message } = statusOf(raw.status);
  const events = arr(raw.events)
    .filter(isRecord)
    .slice(0, 20)
    .map((e) => ({
      name: typeof e.name === "string" ? e.name.slice(0, 200) : "",
      ts: nanosToMs(e.timeUnixNano) ?? start,
      attributes: attributes(e.attributes),
    }));
  return {
    traceId,
    spanId,
    parentSpanId: hexId(raw.parentSpanId, 16),
    name: typeof raw.name === "string" ? raw.name.slice(0, 200) : "",
    start,
    end: Math.max(start, end),
    status,
    statusMessage: message?.slice(0, 2000),
    attributes: attrs,
    events: events.length > 0 ? events : undefined,
    worker: workerNameOf(resource, attrs, fallbackWorker),
    resource,
  };
}

function outcomeError(span: SpanRecord): string | undefined {
  const outcome = str(span.attributes[OUTCOME_KEY]);
  return outcome && !NON_ERROR_OUTCOMES.has(outcome) ? outcome : undefined;
}

function isErrorSpan(span: SpanRecord): boolean {
  return (
    span.status === "error" ||
    outcomeError(span) !== undefined ||
    (span.events ?? []).some((e) => e.name === "exception")
  );
}

/**
 * スパンをトレースごとにまとめ、エラーのスパンを含むトレースだけを残す（技術定義書 3章
 * 「トレース: 既定ではエラーを含むトレースだけを保存する」）。エラーのスパンはイベントにもする。
 */
export function extractTraces(body: unknown, fallbackWorker?: string): Extracted {
  const byTrace = new Map<string, RawSpan[]>();
  if (isRecord(body)) {
    for (const rs of arr(body.resourceSpans)) {
      if (!isRecord(rs)) continue;
      const resource = attributes(isRecord(rs.resource) ? rs.resource.attributes : undefined);
      for (const ss of arr(rs.scopeSpans)) {
        if (!isRecord(ss)) continue;
        for (const raw of arr(ss.spans)) {
          if (!isRecord(raw)) continue;
          const span = parseSpan(raw, resource, fallbackWorker);
          if (!span) continue;
          const list = byTrace.get(span.traceId);
          if (list) {
            if (list.length < MAX_SPANS_PER_TRACE) list.push(span);
          } else byTrace.set(span.traceId, [span]);
        }
      }
    }
  }

  const events: WorkerEvent[] = [];
  const traces: TraceRecord[] = [];
  for (const [traceId, spans] of byTrace) {
    const errorSpans = spans.filter(isErrorSpan);
    if (errorSpans.length === 0) continue;

    const ids = new Set(spans.map((s) => s.spanId));
    const root = spans.find((s) => !s.parentSpanId || !ids.has(s.parentSpanId)) ?? spans[0];
    const rayId =
      spans.map((s) => pick(s.attributes, RAY_ID_KEYS)).find(Boolean) ??
      (root ? pick(root.resource, RAY_ID_KEYS) : undefined);
    const worker = root?.worker ?? "unknown";
    const request = root ? requestOf(root.attributes) : undefined;

    // 例外の情報を持つスパンがあれば、ルートの outcome（exception など）は重ねて数えない。
    // 失敗したサブリクエスト（D1 など）のスパンと、それが伝わって投げられた例外も1件として扱う
    const withException = errorSpans.filter((s) => s.events?.some((e) => e.name === "exception"));
    const exceptionMessages = new Set(
      withException.flatMap((s) =>
        (s.events ?? [])
          .filter((e) => e.name === "exception")
          .map((e) => str(e.attributes["exception.message"]))
          .filter((m): m is string => m !== undefined),
      ),
    );
    for (const span of errorSpans) {
      const exc = span.events?.find((e) => e.name === "exception");
      const outcome = outcomeError(span);
      if (!exc && span.status !== "error" && outcome && withException.length > 0) continue;
      if (!exc && span.statusMessage && exceptionMessages.has(span.statusMessage)) continue;

      let type: string;
      let message: string;
      let stack: string | undefined;
      if (exc) {
        type = str(exc.attributes["exception.type"]) ?? "Error";
        message = str(exc.attributes["exception.message"]) ?? span.statusMessage ?? span.name;
        stack = str(exc.attributes["exception.stacktrace"]);
      } else if (span.status === "error") {
        type = "SpanError";
        message = span.statusMessage ?? `${span.name} failed`;
      } else {
        type = "WorkerOutcome";
        message = `${outcome}${span.name ? ` (${span.name})` : ""}`;
      }
      events.push({
        worker: span.worker,
        ts: exc?.ts ?? span.end,
        type,
        message,
        stack,
        origin: "span",
        traceId,
        spanId: span.spanId,
        rayId,
        request: requestOf(span.attributes) ?? request,
        attributes: extraAttributes(span.attributes),
      });
    }

    traces.push({
      traceId,
      worker,
      rayId,
      spans: spans.map(({ traceId: _t, worker: _w, resource: _r, ...s }) => s),
    });
    if (events.length >= MAX_EVENTS) break;
  }
  return { events, traces };
}

// ---------------------------------------------------------------- Queue メッセージへの分割

/** Queue のメッセージは 128KB まで。余裕を持たせる */
export const MAX_MESSAGE_BYTES = 100 * 1024;

const encoder = new TextEncoder();
const size = (v: unknown) => encoder.encode(JSON.stringify(v)).byteLength;

/**
 * イベントとトレースを、1メッセージが maxBytes を超えないように分ける。
 * 1件で上限を超えるトレースはスパンの属性を削り、それでも超えるならスパン数を減らす。
 */
export function chunkExtracted(data: Extracted, maxBytes = MAX_MESSAGE_BYTES): Extracted[] {
  const chunks: Extracted[] = [];
  let current: Extracted = { events: [], traces: [] };
  let currentSize = 64;

  const flush = () => {
    if (current.events.length + current.traces.length === 0) return;
    chunks.push(current);
    current = { events: [], traces: [] };
    currentSize = 64;
  };

  const add = (kind: "events" | "traces", item: WorkerEvent | TraceRecord, n: number) => {
    if (currentSize + n > maxBytes) flush();
    (current[kind] as unknown[]).push(item);
    currentSize += n + 1;
  };

  for (const e of data.events) {
    let event = e;
    let n = size(event);
    if (n > maxBytes - 64) {
      event = { ...e, stack: e.stack?.slice(0, 8 * 1024), attributes: undefined };
      event.message = event.message.slice(0, 2000);
      n = size(event);
    }
    add("events", event, n);
  }
  for (const t of data.traces) {
    let trace = t;
    let n = size(trace);
    if (n > maxBytes - 64) {
      trace = { ...t, spans: t.spans.map((s) => ({ ...s, attributes: {}, events: undefined })) };
      n = size(trace);
      while (n > maxBytes - 64 && trace.spans.length > 1) {
        trace = { ...trace, spans: trace.spans.slice(0, Math.ceil(trace.spans.length / 2)) };
        n = size(trace);
      }
    }
    add("traces", trace, n);
  }
  flush();
  return chunks;
}
