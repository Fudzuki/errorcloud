// ブラウザSDKの受信口（技術定義書 3章「受信時」、8章）。
// 検証してQueueに積むだけにし、重い処理はコンシューマに回す。
import { Hono } from "hono";
import type { AppEnv, IngestMessage } from "../env";
import { ensureMigrated } from "../migrate";
import { projectForKey } from "../projects";
import { readKey } from "./payload";

export const MAX_PAYLOAD_BYTES = 64 * 1024;

export const receiver = new Hono<{ Bindings: AppEnv }>();

function corsHeaders(origin: string | undefined): Record<string, string> {
  if (!origin) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

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

  if (usedToday >= project.dailyEventLimit) return c.body(null, 429, cors);

  if (c.env.RATE_LIMITER) {
    // IP アドレスは保存しない。流量制限のキーにだけ使う
    const ip = c.req.header("CF-Connecting-IP") ?? "unknown";
    const { success } = await c.env.RATE_LIMITER.limit({ key: `${project.id}:${ip}` });
    if (!success) return c.body(null, 429, cors);
  }

  await c.env.INGEST.send({
    kind: "browser",
    projectId: project.id,
    receivedAt: Date.now(),
    userAgent: c.req.header("User-Agent")?.slice(0, 500),
    body,
  } satisfies IngestMessage);
  return c.body(null, 202, cors);
});
