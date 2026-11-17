import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildBodies, Client, type ErrorEvent, eventFromError } from "../src/client";

const header = { key: "pk_test", release: "r1" };

function ev(i: number, extra: Partial<ErrorEvent> = {}): ErrorEvent {
  return { ts: i, type: "Error", message: `boom ${i}`, kind: "error", ...extra };
}

describe("buildBodies", () => {
  it("上限を超えないように分ける", () => {
    const events = Array.from({ length: 50 }, (_, i) => ev(i, { stack: "x".repeat(100) }));
    const bodies = buildBodies(header, events, 1000);
    expect(bodies.length).toBeGreaterThan(1);
    for (const b of bodies)
      expect(new TextEncoder().encode(b).byteLength).toBeLessThanOrEqual(1000);
    const all = bodies.flatMap((b) => JSON.parse(b).events as ErrorEvent[]);
    expect(all.map((e) => e.ts)).toEqual(events.map((e) => e.ts));
    expect(JSON.parse(bodies[0] ?? "")).toMatchObject({ key: "pk_test", release: "r1" });
  });

  it("1件で上限を超えるイベントはスタックを削る", () => {
    const [body] = buildBodies(header, [ev(1, { stack: "x".repeat(5000) })], 1000);
    expect(JSON.parse(body ?? "").events[0]).toEqual(ev(1));
  });
});

describe("Client", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("数秒分をまとめて1リクエストで送る", () => {
    const sent: [string, boolean][] = [];
    const client = new Client(header, { send: (b, beacon) => sent.push([b, beacon]) });
    client.capture(ev(1));
    client.capture(ev(2));
    expect(sent).toHaveLength(0);
    vi.advanceTimersByTime(3000);
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0]?.[0] ?? "").events).toHaveLength(2);
    expect(sent[0]?.[1]).toBe(false);
  });

  it("同じエラーは1ページ表示あたり5件まで", () => {
    const sent: string[] = [];
    const client = new Client(header, { send: (b) => sent.push(b) });
    for (let i = 0; i < 8; i++) client.capture(ev(i, { message: "same" }));
    client.flush(true);
    expect(JSON.parse(sent[0] ?? "").events).toHaveLength(5);
  });

  it("beforeSend で加工や破棄ができる", () => {
    const sent: string[] = [];
    const client = new Client(
      {
        ...header,
        beforeSend: (e) => (e.message.includes("ignore") ? null : { ...e, extra: { user: "u1" } }),
      },
      { send: (b) => sent.push(b) },
    );
    client.capture(ev(1, { message: "ignore me" }));
    client.capture(ev(2));
    client.flush(false);
    const events = JSON.parse(sent[0] ?? "").events;
    expect(events).toHaveLength(1);
    expect(events[0].extra).toEqual({ user: "u1" });
  });

  it("送信の失敗や beforeSend の例外を外に出さない", () => {
    const client = new Client(
      {
        ...header,
        beforeSend: () => {
          throw new Error("x");
        },
      },
      {
        send: () => {
          throw new Error("y");
        },
      },
    );
    expect(() => client.capture(ev(1))).not.toThrow();
    expect(() => client.flush(false)).not.toThrow();
  });
});

describe("eventFromError", () => {
  it("Error、文字列、その他の値を扱う", () => {
    const e = eventFromError(new TypeError("bad"), "error", "https://x.test/");
    expect(e).toMatchObject({ type: "TypeError", message: "bad", url: "https://x.test/" });
    expect(e.stack).toContain("TypeError");
    expect(eventFromError("oops", "unhandledrejection", undefined)).toMatchObject({
      type: "UnhandledRejection",
      message: "oops",
    });
    expect(eventFromError({ code: 1 }, "manual", undefined).message).toBe('{"code":1}');
  });
});
