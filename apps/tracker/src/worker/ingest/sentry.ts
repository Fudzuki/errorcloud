// Sentry 互換の受信口で使う envelope の解析と変換（技術定義書 2章「Sentry互換」、段階5）。
// event アイテムだけを内部のイベント形式（BrowserEvent）に変換し、それ以外のアイテム
// （session、client_report、transaction、attachment など）は捨てる。
import type { BrowserEvent, BrowserPayload } from "../../shared/types";

const MAX_EVENTS = 20;

export type Envelope = {
  header: Record<string, unknown>;
  items: { header: Record<string, unknown>; payload: Uint8Array }[];
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const decoder = new TextDecoder();

function parseJsonLine(bytes: Uint8Array): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(decoder.decode(bytes));
    return isRecord(v) ? v : null;
  } catch {
    return null;
  }
}

/**
 * envelope は「ヘッダー行」「アイテムヘッダー行」「ペイロード」の繰り返し。ペイロードの長さは
 * アイテムヘッダーの length（バイト数）で示されるか、省略時は次の改行まで。
 */
export function parseEnvelope(bytes: Uint8Array): Envelope | null {
  let pos = 0;
  const nextLine = (): Uint8Array | null => {
    if (pos >= bytes.length) return null;
    let end = bytes.indexOf(0x0a, pos);
    if (end === -1) end = bytes.length;
    const line = bytes.subarray(pos, end);
    pos = end + 1;
    return line;
  };

  const headLine = nextLine();
  if (!headLine) return null;
  const header = parseJsonLine(headLine);
  if (!header) return null;

  const items: Envelope["items"] = [];
  for (;;) {
    const line = nextLine();
    if (line === null) break;
    if (line.length === 0) continue;
    const itemHeader = parseJsonLine(line);
    if (!itemHeader) return null;
    let payload: Uint8Array;
    const length = itemHeader.length;
    if (typeof length === "number" && Number.isInteger(length) && length >= 0) {
      payload = bytes.subarray(pos, pos + length);
      pos += length;
      // ペイロードの後ろの改行
      if (bytes[pos] === 0x0a) pos++;
    } else {
      payload = nextLine() ?? new Uint8Array();
    }
    items.push({ header: itemHeader, payload });
  }
  return { header, items };
}

/** DSN（https://<公開キー>@host/...）から公開キーを取り出す */
export function keyFromDsn(dsn: unknown): string | undefined {
  if (typeof dsn !== "string") return undefined;
  try {
    return new URL(dsn).username || undefined;
  } catch {
    return undefined;
  }
}

/** X-Sentry-Auth: Sentry sentry_key=..., sentry_version=7 から公開キーを取り出す */
export function keyFromAuthHeader(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const m = /sentry_key=([^,\s]+)/.exec(header);
  return m?.[1];
}

function str(v: unknown, max = 1000): string | undefined {
  return typeof v === "string" && v.length > 0 ? v.slice(0, max) : undefined;
}

/** Sentry のタイムスタンプ（UNIX 秒の数値か ISO 8601 の文字列）をミリ秒に */
function toMs(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return Math.round(v * 1000);
  if (typeof v === "string") {
    const t = Date.parse(v);
    return Number.isNaN(t) ? undefined : t;
  }
  return undefined;
}

type SentryFrame = {
  filename?: unknown;
  abs_path?: unknown;
  function?: unknown;
  lineno?: unknown;
  colno?: unknown;
};

/**
 * Sentry のフレーム（古い順、最後が発生箇所）を、Chrome 形式のスタック文字列（発生箇所が先頭）に
 * 戻す。こうすると既存のスタック解析、フィンガープリント、ソースマップ復元がそのまま使える。
 */
export function stackFromFrames(
  type: string,
  message: string,
  frames: unknown,
): string | undefined {
  if (!Array.isArray(frames) || frames.length === 0) return undefined;
  const lines = [`${type}: ${message}`];
  for (const raw of [...frames].reverse().slice(0, 50)) {
    if (!isRecord(raw)) continue;
    const f = raw as SentryFrame;
    const file = str(f.abs_path, 2000) ?? str(f.filename, 2000);
    if (!file) continue;
    const line = typeof f.lineno === "number" ? f.lineno : 0;
    const col = typeof f.colno === "number" ? f.colno : 0;
    const fn = str(f.function, 200);
    lines.push(fn ? `    at ${fn} (${file}:${line}:${col})` : `    at ${file}:${line}:${col}`);
  }
  return lines.length > 1 ? lines.join("\n") : undefined;
}

function kindOf(mechanism: unknown): BrowserEvent["kind"] {
  const type = isRecord(mechanism) ? mechanism.type : undefined;
  if (type === "onerror" || type === "auto.browser.global_handlers.onerror") return "error";
  if (
    type === "onunhandledrejection" ||
    type === "auto.browser.global_handlers.onunhandledrejection"
  ) {
    return "unhandledrejection";
  }
  return "manual";
}

function messageText(event: Record<string, unknown>): string | undefined {
  const m = event.message ?? event.logentry;
  if (typeof m === "string") return m;
  if (isRecord(m)) return str(m.formatted, 10_000) ?? str(m.message, 10_000);
  return undefined;
}

/** Sentry の event を内部の形に変換する。user（IP アドレスなど）は持ち込まない（8章「個人情報」） */
export function convertEvent(event: Record<string, unknown>): {
  event: BrowserEvent;
  release?: string;
  environment?: string;
} | null {
  const values = isRecord(event.exception) ? event.exception.values : event.exception;
  const list = Array.isArray(values) ? values.filter(isRecord) : [];
  // 連鎖した例外は古い順に並び、最後が外側（実際に投げられたもの）
  const exc = list.at(-1);

  let type: string;
  let message: string;
  let stack: string | undefined;
  let kind: BrowserEvent["kind"] = "manual";
  if (exc) {
    type = str(exc.type, 200) ?? "Error";
    message = str(exc.value, 10_000) ?? messageText(event) ?? "";
    const st = isRecord(exc.stacktrace) ? exc.stacktrace : undefined;
    stack = stackFromFrames(type, message, st?.frames);
    kind = kindOf(exc.mechanism);
  } else {
    const text = messageText(event);
    if (!text) return null;
    type = "Message";
    message = text;
    const st = isRecord(event.stacktrace) ? event.stacktrace : undefined;
    stack = stackFromFrames(type, message, st?.frames);
  }

  let fingerprint: string[] | undefined;
  if (Array.isArray(event.fingerprint)) {
    // {{ default }} は「通常のまとめ方」の意味なので、それだけなら指定なしとして扱う
    const parts = event.fingerprint.filter(
      (v): v is string => typeof v === "string" && v !== "{{ default }}",
    );
    if (parts.length > 0) fingerprint = parts.slice(0, 10).map((v) => v.slice(0, 200));
  }

  const extra: Record<string, unknown> = {};
  if (isRecord(event.tags)) extra.tags = event.tags;
  if (isRecord(event.extra)) Object.assign(extra, event.extra);
  if (typeof event.level === "string") extra.level = event.level;
  if (typeof event.event_id === "string") extra.sentryEventId = event.event_id;

  const request = isRecord(event.request) ? event.request : undefined;
  return {
    event: {
      ts: toMs(event.timestamp) ?? Date.now(),
      type,
      message,
      stack,
      url: str(request?.url, 2000),
      kind,
      fingerprint,
      extra: Object.keys(extra).length > 0 ? extra : undefined,
    },
    release: str(event.release, 200),
    environment: str(event.environment, 100),
  };
}

/**
 * envelope から event アイテムだけを取り出し、release と environment ごとに BrowserPayload に
 * まとめる（ふつうは1つ）。
 */
export function payloadsFromEnvelope(envelope: Envelope, key: string): BrowserPayload[] {
  const groups = new Map<string, BrowserPayload>();
  let n = 0;
  for (const item of envelope.items) {
    if (item.header.type !== "event") continue;
    const raw = parseJsonLine(item.payload);
    if (!raw) continue;
    const converted = convertEvent(raw);
    if (!converted) continue;
    const g = `${converted.release ?? ""}\n${converted.environment ?? ""}`;
    const payload = groups.get(g) ?? {
      key,
      release: converted.release,
      environment: converted.environment,
      events: [],
    };
    payload.events.push(converted.event);
    groups.set(g, payload);
    if (++n >= MAX_EVENTS) break;
  }
  return [...groups.values()];
}
