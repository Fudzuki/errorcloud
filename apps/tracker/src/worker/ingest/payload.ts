// ブラウザSDKが送る本文の検証。信頼できない入力なので、知っている項目だけを型を確かめて取り出す。
import type { BrowserEvent, BrowserPayload } from "../../shared/types";

const MAX_EVENTS_PER_REQUEST = 100;
const KINDS = new Set<BrowserEvent["kind"]>(["error", "unhandledrejection", "fetch", "manual"]);

function str(v: unknown, max = 1000): string | undefined {
  return typeof v === "string" && v.length > 0 ? v.slice(0, max) : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 本文から公開キーだけを取り出す。受信口で全体を検証せずにプロジェクトを引くため */
export function readKey(body: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(body);
    return isRecord(parsed) ? str(parsed.key, 100) : undefined;
  } catch {
    return undefined;
  }
}

export function parsePayload(body: string): BrowserPayload | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const key = str(parsed.key, 100);
  if (!key || !Array.isArray(parsed.events)) return null;

  const events: BrowserEvent[] = [];
  for (const raw of parsed.events.slice(0, MAX_EVENTS_PER_REQUEST)) {
    const event = parseEvent(raw);
    if (event) events.push(event);
  }
  return {
    key,
    release: str(parsed.release, 200),
    environment: str(parsed.environment, 100),
    events,
  };
}

function parseEvent(raw: unknown): BrowserEvent | null {
  if (!isRecord(raw)) return null;
  const message = typeof raw.message === "string" ? raw.message : "";
  const type = str(raw.type, 200) ?? "Error";
  if (!message && !raw.stack) return null;

  const kind = KINDS.has(raw.kind as BrowserEvent["kind"])
    ? (raw.kind as BrowserEvent["kind"])
    : "error";

  let request: BrowserEvent["request"];
  if (isRecord(raw.request)) {
    request = {
      url: str(raw.request.url, 2000),
      method: str(raw.request.method, 10),
      status: num(raw.request.status),
      rayId: str(raw.request.rayId, 100),
    };
  }

  let fingerprint: string[] | undefined;
  if (Array.isArray(raw.fingerprint)) {
    fingerprint = raw.fingerprint
      .filter((v): v is string => typeof v === "string")
      .slice(0, 10)
      .map((v) => v.slice(0, 200));
  }

  return {
    ts: num(raw.ts) ?? Date.now(),
    type,
    message: message.slice(0, 10_000),
    stack: str(raw.stack, 64 * 1024),
    url: str(raw.url, 2000),
    kind,
    request,
    fingerprint: fingerprint?.length ? fingerprint : undefined,
    extra: isRecord(raw.extra) ? raw.extra : undefined,
  };
}
