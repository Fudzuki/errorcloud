import { Hono } from "hono";
import { requireAccess } from "./api/access";
import { api } from "./api/routes";
import type { AppEnv, IngestMessage } from "./env";
import { otlp } from "./ingest/otlp-receiver";
import { receiver } from "./ingest/receiver";
import { ensureMigrated } from "./migrate";
import { processMessages } from "./pipeline/consumer";
import { runRetention } from "./retention";

export type { IngestMessage } from "./env";

const app = new Hono<{ Bindings: AppEnv }>();

app.route("/_e", receiver);
app.route("/otlp", otlp);

app.get("/api/health", async (c) => {
  const row = await c.env.DB.prepare("SELECT 1 AS ok").first<{ ok: number }>();
  return c.json({ ok: row?.ok === 1 });
});

app.use("/api/*", requireAccess());
app.use("/api/*", async (c, next) => {
  await ensureMigrated(c.env.DB);
  return next();
});
app.route("/api", api);
app.all("/api/*", (c) => c.json({ error: "not found" }, 404));

app.onError((err, c) => {
  console.error(err);
  return c.json({ error: "internal error" }, 500);
});

export default {
  fetch: app.fetch,

  async queue(
    batch: MessageBatch<IngestMessage>,
    env: AppEnv,
    _ctx: ExecutionContext,
  ): Promise<void> {
    await ensureMigrated(env.DB);
    try {
      const result = await processMessages(
        env,
        batch.messages.map((m) => m.body),
      );
      console.log("ingest batch", { messages: batch.messages.length, ...result });
      batch.ackAll();
    } catch (err) {
      // バッチ単位でまとめて書くので、失敗したらバッチ全体をやり直す
      console.error("ingest batch failed", err);
      batch.retryAll({ delaySeconds: 30 });
    }
  },

  async scheduled(_controller: ScheduledController, env: AppEnv, ctx: ExecutionContext) {
    await ensureMigrated(env.DB);
    ctx.waitUntil(runRetention(env));
  },
} satisfies ExportedHandler<AppEnv, IngestMessage>;

export { app };
