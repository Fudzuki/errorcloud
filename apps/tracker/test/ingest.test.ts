import { createExecutionContext, createMessageBatch, getQueueResult } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { Issue, Page, StoredEvent } from "../src/shared/types";
import worker from "../src/worker";
import type { BrowserMessage, IngestMessage } from "../src/worker/env";
import { processMessages, SAMPLES_PER_ISSUE_HOUR } from "../src/worker/pipeline/consumer";
import { invalidateProjectCache } from "../src/worker/projects";
import { browserEvent, call, createProject, json } from "./helpers";

function send(body: unknown, headers: Record<string, string> = {}) {
  return call("/_e/v1/events", {
    method: "POST",
    headers: { "Content-Type": "text/plain", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function message(projectId: string, payload: unknown, receivedAt = Date.now()): BrowserMessage {
  return {
    kind: "browser",
    projectId,
    receivedAt,
    userAgent: "Mozilla/5.0 (Macintosh) Chrome/140",
    body: JSON.stringify(payload),
  };
}

describe("受信口 POST /_e/v1/events", () => {
  it("公開キーがなければ 400、未知なら 401", async () => {
    expect((await send({ events: [] })).status).toBe(400);
    expect((await send("not json")).status).toBe(400);
    expect((await send({ key: "pk_unknown", events: [] })).status).toBe(401);
  });

  it("64KB を超えると 413", async () => {
    expect((await send("x".repeat(64 * 1024 + 1))).status).toBe(413);
  });

  it("Origin が許可リストになければ 403、あれば 202 と CORS ヘッダー", async () => {
    const p = await createProject({ allowedOrigins: ["https://example.com"] });
    const payload = { key: p.publicKey, events: [browserEvent()] };

    expect((await send(payload)).status).toBe(403);
    expect((await send(payload, { Origin: "https://evil.test" })).status).toBe(403);

    const ok = await send(payload, { Origin: "https://example.com" });
    expect(ok.status).toBe(202);
    expect(ok.headers.get("Access-Control-Allow-Origin")).toBe("https://example.com");
  });

  it("許可リストが空ならどこからでも受ける", async () => {
    const p = await createProject();
    expect((await send({ key: p.publicKey, events: [] })).status).toBe(202);
  });

  it("1日の上限に達したら 429", async () => {
    const p = await createProject({ dailyEventLimit: 1 });
    await processMessages(env, [message(p.id, { key: p.publicKey, events: [browserEvent()] })]);
    invalidateProjectCache();
    expect((await send({ key: p.publicKey, events: [browserEvent()] })).status).toBe(429);
  });
});

describe("コンシューマ", () => {
  it("イベントを issue にまとめ、索引を D1、本体を R2 に置く", async () => {
    const p = await createProject();
    const payload = {
      key: p.publicKey,
      release: "2026.11.17-1",
      environment: "production",
      events: [
        browserEvent({ message: "Item 1 missing" }),
        browserEvent({ message: "Item 2 missing" }),
        browserEvent({
          type: "ReferenceError",
          message: "foo is not defined",
          request: { url: "/api/x?id=1", status: 500, rayId: "8f0c" },
        }),
        browserEvent({ message: "Script error." }),
      ],
    };
    const result = await processMessages(env, [message(p.id, payload)]);
    expect(result).toMatchObject({ accepted: 3, dropped: 1, sampled: 3 });

    const issues = await json<Page<Issue>>(`/api/projects/${p.id}/issues`);
    expect(issues.items).toHaveLength(2);
    const typeError = issues.items.find((i) => i.type === "TypeError");
    expect(typeError).toMatchObject({
      eventCount: 2,
      status: "unresolved",
      culprit: "/assets/app.js",
      message: "Item 1 missing",
    });

    const events = await json<Page<{ id: string; url: string; rayId: string | null }>>(
      `/api/issues/${typeError?.id}/events`,
    );
    expect(events.items).toHaveLength(2);
    // クエリ文字列はマスクして保存する
    expect(events.items[0]?.url).toBe("https://example.com/items/42?token=[Filtered]");

    const body = await json<StoredEvent>(`/api/events/${events.items[0]?.id}`);
    expect(body.release).toBe("2026.11.17-1");
    expect(body.frames[0]).toMatchObject({ function: "r", line: 1, column: 2345, inApp: true });

    const usage = await env.DB.prepare("SELECT count FROM project_usage WHERE project_id = ?")
      .bind(p.id)
      .first<{ count: number }>();
    expect(usage?.count).toBe(3);
  });

  it("issue ごとに1時間あたり10件まで本体を残し、件数はすべて数える", async () => {
    const p = await createProject();
    const at = Date.UTC(2026, 10, 17, 3, 15);
    const events = Array.from({ length: 7 }, () => browserEvent());
    const first = await processMessages(env, [
      message(p.id, { key: p.publicKey, events }, at),
      message(p.id, { key: p.publicKey, events }, at + 1000),
    ]);
    expect(first.sampled).toBe(SAMPLES_PER_ISSUE_HOUR);
    const second = await processMessages(env, [
      message(p.id, { key: p.publicKey, events }, at + 2000),
    ]);
    expect(second.sampled).toBe(0);
    // 次の時間になればまた保存する
    const third = await processMessages(env, [
      message(p.id, { key: p.publicKey, events }, at + 3_600_000),
    ]);
    expect(third.sampled).toBe(7);

    const issue = await env.DB.prepare("SELECT id, event_count FROM issues WHERE project_id = ?")
      .bind(p.id)
      .first<{ id: string; event_count: number }>();
    expect(issue?.event_count).toBe(28);
    const { results: buckets } = await env.DB.prepare(
      "SELECT bucket_start, count FROM issue_buckets WHERE issue_id = ? ORDER BY bucket_start",
    )
      .bind(issue?.id)
      .all();
    expect(buckets).toEqual([
      { bucket_start: Date.UTC(2026, 10, 17, 3) / 1000, count: 21 },
      { bucket_start: Date.UTC(2026, 10, 17, 4) / 1000, count: 7 },
    ]);
  });

  it("解決済みの issue に新しいイベントが来たら未解決に戻す。無視は維持する", async () => {
    const p = await createProject();
    const send1 = () =>
      processMessages(env, [message(p.id, { key: p.publicKey, events: [browserEvent()] })]);
    await send1();
    const { items } = await json<Page<Issue>>(`/api/projects/${p.id}/issues`);
    const id = items[0]?.id;

    await call(`/api/issues/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "resolved" }),
    });
    await send1();
    expect((await json<Issue>(`/api/issues/${id}`)).status).toBe("unresolved");

    await call(`/api/issues/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "ignored" }),
    });
    await send1();
    expect((await json<Issue>(`/api/issues/${id}`)).status).toBe("ignored");
  });

  it("削除済みプロジェクトや壊れたメッセージは捨てる", async () => {
    const result = await processMessages(env, [
      message("no-such-project", { key: "pk_x", events: [browserEvent()] }),
      { ...message("no-such-project", {}), body: "{" },
    ]);
    expect(result.accepted).toBe(0);
  });

  it("queue ハンドラーが成功したバッチを ack する", async () => {
    const p = await createProject();
    const batch = createMessageBatch<IngestMessage>("errorcloud-ingest", [
      {
        id: "m1",
        timestamp: new Date(),
        attempts: 1,
        body: message(p.id, { key: p.publicKey, events: [browserEvent()] }),
      },
    ]);
    const ctx = createExecutionContext();
    await worker.queue(batch, env, ctx);
    const result = await getQueueResult(batch, ctx);
    expect(result.ackAll).toBe(true);
    expect(result.retryBatch.retry).toBe(false);
  });
});
