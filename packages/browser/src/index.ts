// ブラウザSDK（技術定義書 2章）
//
//   import { init } from "@errorcloud/browser";
//   init({ key: "pk_xxxxxxxx", release: "2026.11.17-1", environment: "production" });
//
// error イベント、unhandledrejection、失敗した fetch（ネットワークエラーと5xx）を捕捉し、
// 数秒分をまとめて同一ドメインの /_e/v1/events に送る。
import {
  Client,
  type ClientOptions,
  type ErrorEvent,
  eventFromError,
  type Transport,
} from "./client";

export type { ErrorEvent } from "./client";
export { buildBodies, Client, eventFromError, MAX_REQUEST_BYTES } from "./client";

export type InitOptions = ClientOptions & {
  /** 送信先。既定は同一ドメインの /_e。別アカウント構成では https://errors.example.com/_e */
  endpoint?: string;
  /** 失敗した fetch を捕捉するか。既定は true */
  captureFetch?: boolean;
};

export type CaptureContext = {
  fingerprint?: string[];
  extra?: Record<string, unknown>;
};

let client: Client | undefined;
let originalFetch: typeof fetch | undefined;

function pageUrl(): string | undefined {
  return typeof location !== "undefined" ? location.href : undefined;
}

function createTransport(url: string): Transport {
  // 自分自身の送信を fetch の捕捉対象にしないよう、ラップ前の fetch を使う
  const send = originalFetch ?? fetch;
  return {
    send(body, beacon) {
      try {
        // text/plain ならプリフライトが起きない
        if (beacon && typeof navigator !== "undefined" && navigator.sendBeacon) {
          if (navigator.sendBeacon(url, new Blob([body], { type: "text/plain" }))) return;
        }
        send(url, {
          method: "POST",
          body,
          keepalive: true,
          headers: { "Content-Type": "text/plain" },
        }).catch(() => {});
      } catch {
        // 送信の失敗は握りつぶす
      }
    },
  };
}

function describeRequest(input: RequestInfo | URL, init?: RequestInit) {
  const raw = input instanceof Request ? input.url : String(input);
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  let url = raw;
  try {
    const u = new URL(raw, pageUrl());
    // クエリ文字列は送らない（個人情報を含みうるため）
    url =
      typeof location !== "undefined" && u.origin === location.origin
        ? u.pathname
        : `${u.origin}${u.pathname}`;
  } catch {
    url = raw.split("?")[0] ?? raw;
  }
  return { url, method };
}

function wrapFetch(endpointUrl: string): void {
  if (typeof window === "undefined" || typeof window.fetch !== "function") return;
  const inner = window.fetch.bind(window);
  originalFetch = inner;
  const endpointPath = describeRequest(endpointUrl).url;
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const { url, method } = describeRequest(input, init);
    const own = url === endpointPath;
    try {
      const res = await inner(input, init);
      if (!own && res.status >= 500) {
        client?.capture({
          ts: Date.now(),
          type: "HTTPError",
          message: `${method} ${url} → ${res.status}`,
          url: pageUrl(),
          kind: "fetch",
          request: {
            url,
            method,
            status: res.status,
            rayId: res.headers.get("cf-ray") ?? undefined,
          },
        });
      }
      return res;
    } catch (err) {
      // 利用者による中断はエラーとして扱わない
      if (!own && !(err instanceof DOMException && err.name === "AbortError")) {
        client?.capture({
          ts: Date.now(),
          type: "NetworkError",
          message: `${method} ${url} failed: ${err instanceof Error ? err.message : String(err)}`,
          url: pageUrl(),
          kind: "fetch",
          request: { url, method },
        });
      }
      throw err;
    }
  };
}

export function init(options: InitOptions): void {
  if (client) return;
  const endpoint = (options.endpoint ?? "/_e").replace(/\/+$/, "");
  const url = `${endpoint}/v1/events`;

  if (options.captureFetch !== false) wrapFetch(url);
  client = new Client(options, createTransport(url));
  if (typeof window === "undefined") return;

  window.addEventListener("error", (e) => {
    // 画像などのリソース読み込み失敗は対象外
    if (e.target && e.target !== window) return;
    const event = eventFromError(e.error ?? e.message, "error", pageUrl());
    if (!e.error && e.filename) {
      event.stack = `${event.message}\n    at ${e.filename}:${e.lineno}:${e.colno}`;
    }
    client?.capture(event);
  });

  window.addEventListener("unhandledrejection", (e) => {
    client?.capture(eventFromError(e.reason, "unhandledrejection", pageUrl()));
  });

  // ページ離脱時は sendBeacon で送り切る
  const flushOnLeave = () => client?.flush(true);
  window.addEventListener("pagehide", flushOnLeave);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushOnLeave();
  });
}

/** 手動で例外を送る */
export function captureException(err: unknown, context: CaptureContext = {}): void {
  if (!client) return;
  const event: ErrorEvent = eventFromError(err, "manual", pageUrl());
  if (context.fingerprint) event.fingerprint = context.fingerprint;
  if (context.extra) event.extra = context.extra;
  client.capture(event);
}

/** たまっているイベントをすぐに送る */
export function flush(): void {
  client?.flush(false);
}

export function getOptions(): ClientOptions | undefined {
  return client?.options;
}
