import { Hono } from "hono";

// 1リクエストを1メッセージとしてQueueに積む（技術定義書 3章）
export type IngestMessage = {
  kind: "browser";
  receivedAt: number;
  body: string;
};

const MAX_PAYLOAD_BYTES = 64 * 1024;

const app = new Hono<{ Bindings: Env }>();

app.get("/api/health", async (c) => {
  const row = await c.env.DB.prepare("SELECT 1 AS ok").first<{ ok: number }>();
  return c.json({ ok: row?.ok === 1 });
});

app.post("/_e/v1/events", async (c) => {
  const body = await c.req.text();
  if (new TextEncoder().encode(body).byteLength > MAX_PAYLOAD_BYTES) {
    return c.body(null, 413);
  }
  // TODO: 公開キー・Origin・流量制限の検証（段階1）
  await c.env.INGEST.send({
    kind: "browser",
    receivedAt: Date.now(),
    body,
  } satisfies IngestMessage);
  return c.body(null, 202);
});

export default {
  fetch: app.fetch,

  async queue(batch: MessageBatch<IngestMessage>, _env: Env): Promise<void> {
    // TODO: 正規化、フィンガープリント計算、D1/R2への書き込み（技術定義書 3章）
    for (const message of batch.messages) {
      console.log("ingest", message.body.kind, message.body.body.length);
      message.ack();
    }
  },

  async scheduled(_controller: ScheduledController, _env: Env): Promise<void> {
    // TODO: 保持期間を過ぎたデータの削除（技術定義書 4章）
  },
} satisfies ExportedHandler<Env, IngestMessage>;

export { app };
