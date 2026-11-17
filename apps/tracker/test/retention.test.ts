import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { IngestMessage } from "../src/worker/env";
import { ensureMigrated, splitStatements } from "../src/worker/migrate";
import { processMessages } from "../src/worker/pipeline/consumer";
import { runRetention } from "../src/worker/retention";
import { browserEvent, createProject } from "./helpers";

const DAY = 86_400_000;

describe("保持期間", () => {
  it("期限切れの行と R2 オブジェクトを消し、新しいものは残す", async () => {
    const p = await createProject({ retentionDays: 7 });
    const now = Date.UTC(2026, 10, 17, 18);
    const msg = (receivedAt: number, type: string): IngestMessage => ({
      kind: "browser",
      projectId: p.id,
      receivedAt,
      body: JSON.stringify({ key: p.publicKey, events: [browserEvent({ type })] }),
    });
    await processMessages(env, [msg(now - 10 * DAY, "OldError"), msg(now - DAY, "NewError")]);

    await runRetention(env, now);

    const { results: issues } = await env.DB.prepare("SELECT type FROM issues WHERE project_id = ?")
      .bind(p.id)
      .all<{ type: string }>();
    expect(issues.map((i) => i.type)).toEqual(["NewError"]);
    const events = await env.DB.prepare("SELECT COUNT(*) AS n FROM events WHERE project_id = ?")
      .bind(p.id)
      .first<{ n: number }>();
    expect(events?.n).toBe(1);
    const objects = await env.BUCKET.list({ prefix: `events/${p.id}/` });
    expect(objects.objects.map((o) => o.key.split("/")[2])).toEqual(["2026-11-16"]);
  });
});

describe("マイグレーション", () => {
  it("コメントを除いて文ごとに分ける", () => {
    expect(
      splitStatements("-- c\nCREATE TABLE a (x INT); -- d\n\nCREATE INDEX i ON a (x);\n"),
    ).toEqual(["CREATE TABLE a (x INT)", "CREATE INDEX i ON a (x)"]);
  });

  it("wrangler で適用済みのものは再適用しない", async () => {
    await ensureMigrated(env.DB);
    const { results } = await env.DB.prepare("SELECT name FROM d1_migrations ORDER BY name").all();
    expect(results.map((r) => r.name)).toEqual(["0001_init.sql", "0002_project_usage.sql"]);
  });
});
