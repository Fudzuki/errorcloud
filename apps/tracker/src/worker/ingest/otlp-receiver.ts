// OTLP 受信口（技術定義書 2章「OTLP受信口」、8章、段階3）。
// POST /otlp/v1/logs と POST /otlp/v1/traces。Authorization: Bearer <取り込みトークン> を検証する。
//
// 受信時はエラーのログとエラーを含むトレースだけに絞ってから Queue に積む。Workers は通常のログも
// 大量に送ってくるので、そのまま積むと Queue のオペレーション数（無料枠の最初の制約、10章）と
// 1メッセージ 128KB の上限にすぐ当たるため。エラーが1件もなければ Queue には何も積まない。
import { Hono } from "hono";
import type { AppEnv, WorkerMessage } from "../env";
import { readBody, safeEqual } from "./body";
import { chunkExtracted, type Extracted, extractLogs, extractTraces } from "./otlp";

/** 展開後の本文の上限 */
export const MAX_OTLP_BYTES = 5 * 1024 * 1024;

export const otlp = new Hono<{ Bindings: AppEnv }>();

otlp.use("*", async (c, next) => {
  const token = c.env.INGEST_TOKEN;
  if (!token) return c.json({ error: "INGEST_TOKEN が未設定です" }, 503);
  const auth = c.req.header("Authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  if (!m?.[1] || !(await safeEqual(m[1].trim(), token))) {
    return c.json({ error: "unauthorized" }, 401);
  }
  return next();
});

async function handle(
  req: Request,
  env: AppEnv,
  extract: (body: unknown, fallbackWorker?: string) => Extracted,
): Promise<Response> {
  const type = (req.headers.get("Content-Type") ?? "").toLowerCase();
  if (type.includes("protobuf")) {
    return Response.json({ error: "OTLP は JSON で送ってください" }, { status: 415 });
  }
  const body = await readBody(req, MAX_OTLP_BYTES);
  if (!body.ok) return new Response(null, { status: body.status });

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(body.bytes));
  } catch {
    return Response.json({ error: "JSON として読めません" }, { status: 400 });
  }
  // Worker 名がデータから分からない場合に備え、送信先URLの ?worker= でも指定できる（11章）
  const fallback = new URL(req.url).searchParams.get("worker")?.slice(0, 100) || undefined;
  const extracted = extract(parsed, fallback);

  const receivedAt = Date.now();
  const messages = chunkExtracted(extracted).map(
    (chunk): WorkerMessage => ({ kind: "worker", receivedAt, ...chunk }),
  );
  // sendBatch は合計 256KB までなので、1件ずつ送る
  await Promise.all(messages.map((m) => env.INGEST.send(m)));
  // OTLP/HTTP の成功応答（Export*ServiceResponse）は空のオブジェクトでよい
  return Response.json({});
}

otlp.post("/v1/logs", (c) =>
  handle(c.req.raw, c.env, (body, fallback) => ({
    events: extractLogs(body, fallback),
    traces: [],
  })),
);

otlp.post("/v1/traces", (c) => handle(c.req.raw, c.env, extractTraces));
