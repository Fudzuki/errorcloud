// ブラウザ向けの受信口（技術定義書 3章「受信時」、8章）。
// 検証してQueueに積むだけにし、重い処理はコンシューマに回す。
//
//   POST /_e/v1/events                        ブラウザSDK（段階1）
//   POST /_e/sentry/api/:sentryProject/envelope/  Sentry 互換（段階5）
import { type Context, Hono } from "hono";
import type { BrowserPayload, Project } from "../../shared/types";
import type { AppEnv, BrowserMessage } from "../env";
import { ensureMigrated } from "../migrate";
import { projectForKey } from "../projects";
import { readBody } from "./body";
import { readKey } from "./payload";
import { keyFromAuthHeader, keyFromDsn, parseEnvelope, payloadsFromEnvelope } from "./sentry";

export const MAX_PAYLOAD_BYTES = 64 * 1024;
/** Sentry の envelope は変換で小さくなるので、受け取る大きさには余裕を持たせる */
export const MAX_ENVELOPE_BYTES = 256 * 1024;

type Ctx = Context<{ Bindings: AppEnv }>;

export const receiver = new Hono<{ Bindings: AppEnv }>();

function corsHeaders(origin: string | undefined): Record<string, string> {
  if (!origin) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST",
    "Access-Control-Allow-Headers": "Content-Type, X-Sentry-Auth",
    "Access-Control-Expose-Headers": "Retry-After, X-Sentry-Rate-Limits",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

/** UTC の次の0時までの秒数。1日の上限に達したときの Retry-After */
function secondsUntilTomorrow(now = Date.now()): number {
  return Math.max(1, Math.ceil((86_400_000 - (now % 86_400_000)) / 1000));
}

type Admitted = { project: Project; cors: Record<string, string> };

/**
 * 公開キー、Origin の許可リスト、1日の上限、流量制限を確かめる。通らなければ返すべき Response。
 */
async function admit(c: Ctx, key: string): Promise<Admitted | Response> {
  await ensureMigrated(c.env.DB);
  const entry = await projectForKey(c.env.DB, key);
  if (!entry) return c.body(null, 401);
  const { project, usedToday } = entry;

  // Origin の許可リスト。空のときはどこからでも受ける（ダッシュボードで警告を出す）
  const origin = c.req.header("Origin");
  if (project.allowedOrigins.length > 0 && (!origin || !project.allowedOrigins.includes(origin))) {
    return c.body(null, 403);
  }
  const cors = corsHeaders(origin);

  if (usedToday >= project.dailyEventLimit) {
    const retry = String(secondsUntilTomorrow());
    return c.body(null, 429, {
      ...cors,
      "Retry-After": retry,
      // Sentry の SDK はこのヘッダーを見て送信を止める
      "X-Sentry-Rate-Limits": `${retry}::organization`,
    });
  }

  if (c.env.RATE_LIMITER) {
    // IP アドレスは保存しない。流量制限のキーにだけ使う
    const ip = c.req.header("CF-Connecting-IP") ?? "unknown";
    const { success } = await c.env.RATE_LIMITER.limit({ key: `${project.id}:${ip}` });
    if (!success) {
      return c.body(null, 429, { ...cors, "Retry-After": "60", "X-Sentry-Rate-Limits": "60::" });
    }
  }
  return { project, cors };
}

async function enqueue(c: Ctx, projectId: string, body: string): Promise<void> {
  await c.env.INGEST.send({
    kind: "browser",
    projectId,
    receivedAt: Date.now(),
    userAgent: c.req.header("User-Agent")?.slice(0, 500),
    body,
  } satisfies BrowserMessage);
}

// ---------------------------------------------------------------- ブラウザSDK

// SDK は text/plain で送るのでプリフライトは起きないが、別アカウント構成（9章）で
// 利用者が独自のヘッダーを付けた場合に備えて答えておく
receiver.options("/v1/events", (c) => {
  return c.body(null, 204, corsHeaders(c.req.header("Origin")));
});

receiver.post("/v1/events", async (c) => {
  const declared = Number(c.req.header("Content-Length") ?? "0");
  if (declared > MAX_PAYLOAD_BYTES) return c.body(null, 413);
  const body = await c.req.text();
  if (new TextEncoder().encode(body).byteLength > MAX_PAYLOAD_BYTES) return c.body(null, 413);

  const key = readKey(body);
  if (!key) return c.body(null, 400);

  const admitted = await admit(c, key);
  if (admitted instanceof Response) return admitted;

  await enqueue(c, admitted.project.id, body);
  return c.body(null, 202, admitted.cors);
});

// ---------------------------------------------------------------- Sentry 互換（段階5）
//
// DSN を https://<公開キー>@<サイトのドメイン>/_e/sentry/1 にすると、Sentry の SDK は
// https://<サイトのドメイン>/_e/sentry/api/1/envelope/ に送る。/_e/* の下なので、
// 監視対象サイトのルートと Access のバイパス設定はブラウザSDKと共通で済む。
// 末尾の数字は SDK の DSN の形式に合わせるためのもので、プロジェクトは公開キーで決める。

const ENVELOPE_PATHS = [
  "/sentry/api/:sentryProject/envelope/",
  "/sentry/api/:sentryProject/envelope",
];

for (const path of ENVELOPE_PATHS) {
  receiver.options(path, (c) => c.body(null, 204, corsHeaders(c.req.header("Origin"))));
  receiver.post(path, handleEnvelope);
}

const encoder = new TextEncoder();

/** 変換後の本文が受信口の上限に収まるよう、大きいものから削る */
function fitPayload(payload: BrowserPayload): string | null {
  let body = JSON.stringify(payload);
  if (encoder.encode(body).byteLength <= MAX_PAYLOAD_BYTES) return body;
  const trimmed: BrowserPayload = {
    ...payload,
    events: payload.events.map((e) => ({
      ...e,
      extra: undefined,
      stack: e.stack?.slice(0, 16 * 1024),
      message: e.message.slice(0, 2000),
    })),
  };
  body = JSON.stringify(trimmed);
  return encoder.encode(body).byteLength <= MAX_PAYLOAD_BYTES ? body : null;
}

async function handleEnvelope(c: Ctx): Promise<Response> {
  const read = await readBody(c.req.raw, MAX_ENVELOPE_BYTES);
  if (!read.ok) return c.body(null, read.status, corsHeaders(c.req.header("Origin")));
  const envelope = parseEnvelope(read.bytes);
  if (!envelope) return c.json({ detail: "envelope を読めません" }, 400);

  // ブラウザの SDK はプリフライトを避けるためクエリ文字列で、サーバーの SDK はヘッダーで送る
  const key =
    c.req.query("sentry_key") ??
    keyFromAuthHeader(c.req.header("X-Sentry-Auth")) ??
    keyFromAuthHeader(c.req.header("Authorization")) ??
    keyFromDsn(envelope.header.dsn);
  if (!key) return c.json({ detail: "公開キー（sentry_key）がありません" }, 401);

  const admitted = await admit(c, key);
  if (admitted instanceof Response) return admitted;

  const eventId = typeof envelope.header.event_id === "string" ? envelope.header.event_id : null;
  // session や client_report だけの envelope は Queue に積まずに受け取ったことにする
  const bodies = payloadsFromEnvelope(envelope, key)
    .map(fitPayload)
    .filter((b): b is string => b !== null);
  await Promise.all(bodies.map((b) => enqueue(c, admitted.project.id, b)));
  return c.json({ id: eventId }, 200, admitted.cors);
}
