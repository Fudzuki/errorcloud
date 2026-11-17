import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type {
  Issue,
  Page,
  Related,
  StoredEvent,
  StoredTrace,
  WorkerMapping,
} from "../src/shared/types";
import type { WorkerMessage } from "../src/worker/env";
import { chunkExtracted, extractLogs, extractTraces, nanosToMs } from "../src/worker/ingest/otlp";
import { processMessages } from "../src/worker/pipeline/consumer";
import { browserEvent, call, createProject, json } from "./helpers";

const T0 = 1_795_000_000_000;
const ns = (ms: number) => `${ms}000000`;
const s = (key: string, value: string) => ({ key, value: { stringValue: value } });

let traceSeq = 0;
function ids() {
  traceSeq++;
  const hex = traceSeq.toString(16).padStart(4, "0");
  return {
    traceId: `${hex}${"a".repeat(28)}`,
    root: `${hex}${"b".repeat(12)}`,
    child: `${hex}${"c".repeat(12)}`,
  };
}

function logsBody(worker: string, records: object[]) {
  return {
    resourceLogs: [
      {
        resource: { attributes: [s("cloudflare.script_name", worker)] },
        scopeLogs: [{ logRecords: records }],
      },
    ],
  };
}

function tracesBody(worker: string, spans: object[]) {
  return {
    resourceSpans: [
      {
        resource: { attributes: [s("service.name", worker)] },
        scopeSpans: [{ spans }],
      },
    ],
  };
}

const STACK = "Error: boom\n    at Object.fetch (index.js:12:11)\n    at node:internal/x:1:1";

function errorTrace(worker: string, ray = "8f0c1234abcd5678") {
  const id = ids();
  const body = tracesBody(worker, [
    {
      traceId: id.traceId,
      spanId: id.root,
      name: "fetch",
      startTimeUnixNano: ns(T0),
      endTimeUnixNano: ns(T0 + 40),
      attributes: [
        s("cloudflare.ray_id", ray),
        s("cloudflare.outcome", "exception"),
        s("http.request.method", "GET"),
        s("url.full", "https://api.example.com/items?id=1"),
      ],
    },
    {
      traceId: id.traceId,
      spanId: id.child,
      parentSpanId: id.root,
      name: "handler",
      startTimeUnixNano: ns(T0 + 5),
      endTimeUnixNano: ns(T0 + 30),
      status: { code: 2, message: "boom" },
      events: [
        {
          name: "exception",
          timeUnixNano: ns(T0 + 29),
          attributes: [
            s("exception.type", "Error"),
            s("exception.message", "boom"),
            s("exception.stacktrace", STACK),
          ],
        },
      ],
    },
  ]);
  return { id, body };
}

function postOtlp(path: string, body: unknown, token = "dev-ingest-token") {
  return call(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

function workerMessage(extracted: ReturnType<typeof extractTraces>, receivedAt = Date.now()) {
  return { kind: "worker", receivedAt, ...extracted } satisfies WorkerMessage;
}

async function assign(worker: string, projectId: string | null) {
  return json<WorkerMapping>(`/api/workers/${worker}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ projectId }),
  });
}

describe("OTLP の解析", () => {
  it("timeUnixNano を桁あふれせずにミリ秒にする", () => {
    expect(nanosToMs("1795000000123456789")).toBe(1795000000123);
    expect(nanosToMs(1_000_000)).toBe(1);
  });

  it("ERROR 以上のログと例外を持つログだけを取り出す", () => {
    const events = extractLogs(
      logsBody("api", [
        { severityNumber: 9, body: { stringValue: "hello" } },
        { severityText: "ERROR", timeUnixNano: ns(T0), body: { stringValue: "db failed" } },
        {
          severityNumber: "SEVERITY_NUMBER_WARN",
          attributes: [s("exception.type", "TypeError"), s("exception.message", "x is undefined")],
        },
      ]),
    );
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      worker: "api",
      type: "LogError",
      message: "db failed",
      ts: T0,
    });
    expect(events[1]).toMatchObject({ type: "TypeError", message: "x is undefined" });
  });

  it("エラーのないトレースは捨て、エラーのスパンをイベントにする", () => {
    const ok = ids();
    const { id, body } = errorTrace("api");
    const spans = body.resourceSpans[0]?.scopeSpans[0]?.spans ?? [];
    spans.push({
      traceId: ok.traceId,
      spanId: ok.root,
      name: "fetch",
      startTimeUnixNano: ns(T0),
      endTimeUnixNano: ns(T0 + 1),
      attributes: [s("cloudflare.outcome", "ok")],
    } as never);

    const { events, traces } = extractTraces(body);
    expect(traces.map((t) => t.traceId)).toEqual([id.traceId]);
    expect(traces[0]).toMatchObject({ worker: "api", rayId: "8f0c1234abcd5678" });
    expect(traces[0]?.spans).toHaveLength(2);
    // 例外を持つスパンがあるので、ルートの outcome=exception は重ねて数えない
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "Error",
      message: "boom",
      stack: STACK,
      traceId: id.traceId,
      rayId: "8f0c1234abcd5678",
      request: { method: "GET", url: "https://api.example.com/items?id=1" },
    });
  });

  it("例外と同じメッセージで失敗したスパンは重ねて数えない", () => {
    const id = ids();
    const { events } = extractTraces(
      tracesBody("api", [
        { traceId: id.traceId, spanId: id.root, name: "fetch", startTimeUnixNano: ns(T0) },
        {
          traceId: id.traceId,
          spanId: id.child,
          parentSpanId: id.root,
          name: "d1_query",
          status: { code: 2, message: "D1_ERROR: constraint failed" },
        },
        {
          traceId: id.traceId,
          spanId: "dddddddddddddddd",
          parentSpanId: id.root,
          name: "handler",
          events: [
            {
              name: "exception",
              attributes: [
                s("exception.type", "Error"),
                s("exception.message", "D1_ERROR: constraint failed"),
              ],
            },
          ],
        },
      ]),
    );
    expect(events.map((e) => `${e.type}: ${e.message}`)).toEqual([
      "Error: D1_ERROR: constraint failed",
    ]);
  });

  it("128KB を超えないようにメッセージを分ける", () => {
    const events = Array.from({ length: 50 }, (_, i) => ({
      worker: "api",
      ts: T0,
      type: "Error",
      message: `${i} ${"x".repeat(5000)}`,
      origin: "log" as const,
    }));
    const chunks = chunkExtracted({ events, traces: [] }, 64 * 1024);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.flatMap((c) => c.events)).toHaveLength(50);
    for (const c of chunks) expect(JSON.stringify(c).length).toBeLessThanOrEqual(64 * 1024);
  });
});

describe("OTLP 受信口", () => {
  it("取り込みトークンがなければ 401", async () => {
    expect((await postOtlp("/otlp/v1/logs", {}, "wrong")).status).toBe(401);
    const res = await call("/otlp/v1/logs", { method: "POST", body: "{}" });
    expect(res.status).toBe(401);
  });

  it("JSON でなければ 400、protobuf は 415", async () => {
    const bad = await call("/otlp/v1/logs", {
      method: "POST",
      headers: { Authorization: "Bearer dev-ingest-token" },
      body: "{",
    });
    expect(bad.status).toBe(400);
    const pb = await call("/otlp/v1/traces", {
      method: "POST",
      headers: {
        Authorization: "Bearer dev-ingest-token",
        "Content-Type": "application/x-protobuf",
      },
      body: "x",
    });
    expect(pb.status).toBe(415);
  });

  it("受け付けたら 200 と空の応答（エラーがなくても）", async () => {
    const res = await postOtlp("/otlp/v1/logs", logsBody("api", [{ severityNumber: 9 }]));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
    expect((await postOtlp("/otlp/v1/traces", errorTrace("api").body)).status).toBe(200);
  });

  it("gzip で圧縮された本文を展開する", async () => {
    const raw = new Blob([JSON.stringify(logsBody("api", []))]).stream();
    const gz = await new Response(raw.pipeThrough(new CompressionStream("gzip"))).arrayBuffer();
    const res = await call("/otlp/v1/logs", {
      method: "POST",
      headers: { Authorization: "Bearer dev-ingest-token", "Content-Encoding": "gzip" },
      body: gz,
    });
    expect(res.status).toBe(200);
  });
});

describe("Worker のイベントの処理", () => {
  it("未割り当ての Worker は記録だけして捨て、割り当て後は issue にする", async () => {
    const worker = `w-${Date.now()}`;
    const p = await createProject();
    const msg = workerMessage(extractTraces(errorTrace(worker).body));

    const first = await processMessages(env, [msg]);
    expect(first).toMatchObject({ accepted: 0, unassigned: 1 });
    const unassigned = await json<WorkerMapping[]>("/api/workers/unassigned");
    expect(unassigned.find((w) => w.name === worker)).toMatchObject({
      projectId: null,
      eventCount: 1,
    });

    await assign(worker, p.id);
    expect(
      (await json<WorkerMapping[]>("/api/workers/unassigned")).some((w) => w.name === worker),
    ).toBe(false);
    expect(await json<WorkerMapping[]>(`/api/workers?project=${p.id}`)).toHaveLength(1);

    const msg2 = workerMessage(extractTraces(errorTrace(worker).body));
    const second = await processMessages(env, [msg2]);
    expect(second).toMatchObject({ accepted: 1, sampled: 1, traces: 1 });

    const issues = await json<Page<Issue>>(`/api/projects/${p.id}/issues`);
    expect(issues.items[0]).toMatchObject({
      source: "worker",
      type: "Error",
      message: "boom",
      culprit: `${worker} · index.js`,
    });
    const events = await json<Page<{ id: string; rayId: string; traceId: string }>>(
      `/api/issues/${issues.items[0]?.id}/events`,
    );
    expect(events.items[0]).toMatchObject({
      rayId: "8f0c1234abcd5678",
      traceId: msg2.traces[0]?.traceId,
    });

    const body = await json<StoredEvent>(`/api/events/${events.items[0]?.id}`);
    expect(body.source).toBe("worker");
    expect(body.worker).toMatchObject({ name: worker });
    expect(body.frames[0]).toMatchObject({
      function: "Object.fetch",
      file: "index.js",
      inApp: true,
    });
    expect(body.frames[1]?.inApp).toBe(false);
    // URL のクエリ文字列はマスクする
    expect(body.event.request?.url).toBe("https://api.example.com/items?id=[Filtered]");

    const trace = await json<StoredTrace>(`/api/traces/${msg2.traces[0]?.traceId}`);
    expect(trace).toMatchObject({ worker, projectId: p.id, durationMs: 40 });
    expect(trace.spans).toHaveLength(2);
  });

  it("同じトレースのログとスパンの同じ例外は1件にまとめ、ログに Ray ID を補う", async () => {
    const worker = `w2-${Date.now()}`;
    const p = await createProject();
    await assign(worker, p.id);
    const { id, body } = errorTrace(worker, "9a9a9a9a9a9a9a9a");
    const logs = extractLogs(
      logsBody(worker, [
        {
          severityNumber: 17,
          traceId: id.traceId,
          attributes: [s("exception.type", "Error"), s("exception.message", "boom")],
        },
        { severityNumber: 17, traceId: id.traceId, body: { stringValue: "other failure" } },
      ]),
    );
    const result = await processMessages(env, [
      workerMessage({ events: logs, traces: [] }),
      workerMessage(extractTraces(body)),
    ]);
    expect(result).toMatchObject({ accepted: 2, dropped: 1 });
    const { results } = await env.DB.prepare(
      "SELECT ray_id FROM events WHERE project_id = ? AND trace_id = ?",
    )
      .bind(p.id, id.traceId)
      .all<{ ray_id: string }>();
    expect(results.map((r) => r.ray_id)).toEqual(["9a9a9a9a9a9a9a9a", "9a9a9a9a9a9a9a9a"]);
  });

  it("別のバッチで届いたスパンは保存済みのトレースに追記する", async () => {
    const worker = `w3-${Date.now()}`;
    const p = await createProject();
    await assign(worker, p.id);
    const { id, body } = errorTrace(worker);
    await processMessages(env, [workerMessage(extractTraces(body))]);
    const extra = extractTraces(
      tracesBody(worker, [
        {
          traceId: id.traceId,
          spanId: "ffffffffffffffff",
          parentSpanId: id.root,
          name: "late",
          startTimeUnixNano: ns(T0 + 10),
          endTimeUnixNano: ns(T0 + 100),
          status: { code: "STATUS_CODE_ERROR" },
        },
      ]),
    );
    await processMessages(env, [workerMessage(extra)]);
    const trace = await json<StoredTrace>(`/api/traces/${id.traceId}`);
    expect(trace.spans.map((x) => x.name).sort()).toEqual(["fetch", "handler", "late"]);
    expect(trace.durationMs).toBe(100);
  });
});

describe("Ray ID での紐づけ（段階4）", () => {
  it("ブラウザの失敗した fetch から Worker 側のイベントとトレースを引く", async () => {
    const browser = await createProject();
    const api = await createProject();
    const worker = `w4-${Date.now()}`;
    await assign(worker, api.id);
    const ray = "7b7b7b7b7b7b7b7b";

    await processMessages(env, [
      {
        kind: "browser",
        projectId: browser.id,
        receivedAt: Date.now(),
        body: JSON.stringify({
          key: browser.publicKey,
          events: [
            browserEvent({
              type: "HTTPError",
              message: "GET /api/items → 500",
              kind: "fetch",
              // cf-ray ヘッダーにはデータセンター名が付く
              request: { url: "/api/items", status: 500, rayId: `${ray}-NRT` },
            }),
          ],
        }),
      },
      workerMessage(extractTraces(errorTrace(worker, ray).body)),
    ]);

    const issues = await json<Page<Issue>>(`/api/projects/${browser.id}/issues`);
    const events = await json<Page<{ id: string; rayId: string }>>(
      `/api/issues/${issues.items[0]?.id}/events`,
    );
    expect(events.items[0]?.rayId).toBe(ray);

    const related = await json<Related>(`/api/events/${events.items[0]?.id}/related`);
    expect(related.rayId).toBe(ray);
    expect(related.events).toHaveLength(1);
    expect(related.events[0]).toMatchObject({ source: "worker", projectId: api.id, type: "Error" });
    expect(related.traces).toHaveLength(1);
    expect(related.traces[0]).toMatchObject({ worker, hasError: true });

    // 逆向きも引ける
    const back = await json<Related>(`/api/events/${related.events[0]?.id}/related`);
    expect(back.events.some((e) => e.source === "browser")).toBe(true);
  });

  it("Ray ID もトレースIDもなければ空", async () => {
    const p = await createProject();
    await processMessages(env, [
      {
        kind: "browser",
        projectId: p.id,
        receivedAt: Date.now(),
        body: JSON.stringify({ key: p.publicKey, events: [browserEvent()] }),
      },
    ]);
    const issues = await json<Page<Issue>>(`/api/projects/${p.id}/issues`);
    const events = await json<Page<{ id: string }>>(`/api/issues/${issues.items[0]?.id}/events`);
    expect(await json<Related>(`/api/events/${events.items[0]?.id}/related`)).toEqual({
      rayId: null,
      events: [],
      traces: [],
    });
  });

  it("存在しないプロジェクトへの割り当ては 404", async () => {
    const res = await call("/api/workers/some-worker", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: "no-such" }),
    });
    expect(res.status).toBe(404);
  });
});
