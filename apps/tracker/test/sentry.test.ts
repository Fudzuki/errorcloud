import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { BrowserPayload, Issue, Page, StoredEvent } from "../src/shared/types";
import { convertEvent, parseEnvelope } from "../src/worker/ingest/sentry";
import { processMessages } from "../src/worker/pipeline/consumer";
import { call, createProject, json } from "./helpers";

const SENTRY_EVENT = {
  event_id: "0123456789abcdef0123456789abcdef",
  timestamp: 1795000000.5,
  platform: "javascript",
  level: "error",
  release: "2026.11.17-1",
  environment: "production",
  request: { url: "https://example.com/items/42?token=secret" },
  user: { ip_address: "203.0.113.1", email: "someone@example.com" },
  tags: { feature: "checkout" },
  exception: {
    values: [
      { type: "Error", value: "inner cause" },
      {
        type: "TypeError",
        value: "Cannot read properties of undefined (reading 'id')",
        mechanism: { type: "onerror", handled: false },
        stacktrace: {
          // Sentry は古い順。最後が発生箇所
          frames: [
            { filename: "https://example.com/assets/vendor-9b8c7d6e.js", lineno: 2, colno: 100 },
            {
              filename: "https://example.com/assets/app-3f9a2c1d.js",
              function: "r",
              lineno: 1,
              colno: 2345,
              in_app: true,
            },
          ],
        },
      },
    ],
  },
};

function envelope(items: { header: object; payload: string }[], header: object = {}): string {
  const lines = [
    JSON.stringify({ event_id: SENTRY_EVENT.event_id, sent_at: "2026-11-17T00:00:00Z", ...header }),
  ];
  for (const item of items) {
    lines.push(JSON.stringify(item.header), item.payload);
  }
  return `${lines.join("\n")}\n`;
}

const eventItem = (payload: object = SENTRY_EVENT) => {
  const body = JSON.stringify(payload);
  return {
    header: { type: "event", length: new TextEncoder().encode(body).byteLength },
    payload: body,
  };
};
const sessionItem = {
  header: { type: "session" },
  payload: JSON.stringify({ sid: "x", status: "ok" }),
};

function send(body: string, query = "", headers: Record<string, string> = {}) {
  return call(`/_e/sentry/api/1/envelope/${query}`, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=UTF-8", ...headers },
    body,
  });
}

describe("envelope の解析と変換", () => {
  it("length 付きとなしのアイテムを読む", () => {
    const parsed = parseEnvelope(new TextEncoder().encode(envelope([eventItem(), sessionItem])));
    expect(parsed?.items.map((i) => i.header.type)).toEqual(["event", "session"]);
  });

  it("外側の例外を使い、フレームを Chrome 形式のスタックに戻す。user は持ち込まない", () => {
    const converted = convertEvent(SENTRY_EVENT);
    expect(converted?.release).toBe("2026.11.17-1");
    expect(converted?.event).toMatchObject({
      type: "TypeError",
      kind: "error",
      ts: 1795000000500,
      url: "https://example.com/items/42?token=secret",
    });
    expect(converted?.event.stack?.split("\n")).toEqual([
      "TypeError: Cannot read properties of undefined (reading 'id')",
      "    at r (https://example.com/assets/app-3f9a2c1d.js:1:2345)",
      "    at https://example.com/assets/vendor-9b8c7d6e.js:2:100",
    ]);
    expect(JSON.stringify(converted)).not.toContain("203.0.113.1");
    expect(converted?.event.extra).toMatchObject({ tags: { feature: "checkout" }, level: "error" });
  });

  it("captureMessage は Message 型にし、{{ default }} だけの fingerprint は無視する", () => {
    const c = convertEvent({ message: { formatted: "hello" }, fingerprint: ["{{ default }}"] });
    expect(c?.event).toMatchObject({ type: "Message", message: "hello", kind: "manual" });
    expect(c?.event.fingerprint).toBeUndefined();
    expect(
      convertEvent({ fingerprint: ["{{ default }}", "checkout"], message: "x" })?.event.fingerprint,
    ).toEqual(["checkout"]);
  });
});

describe("Sentry 互換の受信口", () => {
  it("sentry_key で受け、event_id を返し、CORS ヘッダーを付ける", async () => {
    const p = await createProject({ allowedOrigins: ["https://example.com"] });
    const res = await send(envelope([eventItem()]), `?sentry_key=${p.publicKey}&sentry_version=7`, {
      Origin: "https://example.com",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: SENTRY_EVENT.event_id });
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://example.com");
  });

  it("X-Sentry-Auth ヘッダーと envelope の dsn からも公開キーを読む", async () => {
    const p = await createProject();
    expect(
      (
        await send(envelope([eventItem()]), "", {
          "X-Sentry-Auth": `Sentry sentry_key=${p.publicKey}, sentry_version=7`,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await send(
          envelope([eventItem()], { dsn: `https://${p.publicKey}@site.example/_e/sentry/1` }),
        )
      ).status,
    ).toBe(200);
  });

  it("キーがなければ 401、未知なら 401、Origin が違えば 403、壊れていれば 400", async () => {
    const p = await createProject({ allowedOrigins: ["https://example.com"] });
    expect((await send(envelope([eventItem()]))).status).toBe(401);
    expect((await send(envelope([eventItem()]), "?sentry_key=pk_unknown")).status).toBe(401);
    expect(
      (
        await send(envelope([eventItem()]), `?sentry_key=${p.publicKey}`, {
          Origin: "https://evil.test",
        })
      ).status,
    ).toBe(403);
    expect((await send("not an envelope", `?sentry_key=${p.publicKey}`)).status).toBe(400);
  });

  it("session だけの envelope は 200 で受け、何も積まない", async () => {
    const p = await createProject();
    const res = await send(envelope([sessionItem]), `?sentry_key=${p.publicKey}`);
    expect(res.status).toBe(200);
  });

  it("1日の上限に達したら 429 と Retry-After", async () => {
    const p = await createProject({ dailyEventLimit: 1 });
    await env.DB.prepare("INSERT INTO project_usage (project_id, day, count) VALUES (?, ?, 1)")
      .bind(p.id, new Date().toISOString().slice(0, 10))
      .run();
    const res = await send(envelope([eventItem()]), `?sentry_key=${p.publicKey}`);
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(res.headers.get("X-Sentry-Rate-Limits")).toBeTruthy();
  });

  it("変換したイベントはブラウザSDKのものと同じ issue にまとまる", async () => {
    const p = await createProject();
    const converted = convertEvent(SENTRY_EVENT);
    if (!converted) throw new Error("変換できない");
    const payload: BrowserPayload = {
      key: p.publicKey,
      release: converted.release,
      environment: converted.environment,
      events: [converted.event],
    };
    await processMessages(env, [
      { kind: "browser", projectId: p.id, receivedAt: Date.now(), body: JSON.stringify(payload) },
    ]);
    const issues = await json<Page<Issue>>(`/api/projects/${p.id}/issues`);
    expect(issues.items[0]).toMatchObject({ type: "TypeError", culprit: "/assets/app.js" });
    const events = await json<Page<{ id: string }>>(`/api/issues/${issues.items[0]?.id}/events`);
    const body = await json<StoredEvent>(`/api/events/${events.items[0]?.id}`);
    expect(body.event.url).toBe("https://example.com/items/42?token=[Filtered]");
    expect(body.frames[0]).toMatchObject({ function: "r", line: 1, column: 2345, inApp: true });
  });
});
