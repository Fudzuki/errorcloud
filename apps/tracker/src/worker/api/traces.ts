// トレースと、Ray ID・トレースIDでの紐づけ（技術定義書 5章、段階4）
import { Hono } from "hono";
import type { Related, RelatedEvent, TraceSummary } from "../../shared/types";
import type { AppEnv } from "../env";

export const traces = new Hono<{ Bindings: AppEnv }>();

type TraceRow = {
  trace_id: string;
  project_id: string;
  worker_name: string;
  ts: number;
  duration_ms: number | null;
  has_error: number;
  ray_id: string | null;
};

export function toTraceSummary(r: TraceRow): TraceSummary {
  return {
    traceId: r.trace_id,
    projectId: r.project_id,
    worker: r.worker_name,
    ts: r.ts,
    durationMs: r.duration_ms,
    hasError: r.has_error === 1,
    rayId: r.ray_id,
  };
}

traces.get("/traces/:id", async (c) => {
  const row = await c.env.DB.prepare("SELECT r2_key FROM traces WHERE trace_id = ?")
    .bind(c.req.param("id").toLowerCase())
    .first<{ r2_key: string }>();
  if (!row) return c.json({ error: "not found" }, 404);
  const obj = await c.env.BUCKET.get(row.r2_key);
  if (!obj) {
    return c.json({ error: "トレース本体が見つかりません（保持期間切れの可能性があります）" }, 404);
  }
  return new Response(obj.body, { headers: { "Content-Type": "application/json" } });
});

const RELATED_LIMIT = 50;

/**
 * Ray ID が一致するイベントとトレース。ブラウザの失敗した fetch（cf-ray）と、そのリクエストを
 * 処理した Worker 側のエラー・トレースを結びつける。Ray ID を持たない Worker のログは、
 * 同じトレースIDを経由して引く。プロジェクトはまたいで探す。
 */
traces.get("/events/:id/related", async (c) => {
  const db = c.env.DB;
  const event = await db
    .prepare("SELECT id, ray_id, trace_id FROM events WHERE id = ?")
    .bind(c.req.param("id"))
    .first<{ id: string; ray_id: string | null; trace_id: string | null }>();
  if (!event) return c.json({ error: "not found" }, 404);

  const empty: Related = { rayId: event.ray_id, events: [], traces: [] };
  if (!event.ray_id && !event.trace_id) return c.json(empty);

  const { results: traceRows } = await db
    .prepare(
      `SELECT * FROM traces WHERE ray_id = ?1 OR trace_id = ?2 ORDER BY ts DESC LIMIT ${RELATED_LIMIT}`,
    )
    .bind(event.ray_id, event.trace_id)
    .all<TraceRow>();
  const traceIds = [...new Set([event.trace_id, ...traceRows.map((t) => t.trace_id)])].filter(
    (v): v is string => Boolean(v),
  );

  const { results: eventRows } = await db
    .prepare(
      `SELECT e.id, e.issue_id, e.project_id, e.ts, e.release, e.environment, e.url, e.user_agent,
              e.ray_id, e.trace_id, i.source, i.type, i.message
         FROM events e JOIN issues i ON i.id = e.issue_id
        WHERE e.id != ?1
          AND (e.ray_id = ?2 OR e.trace_id IN (SELECT value FROM json_each(?3)))
        ORDER BY e.ts DESC LIMIT ${RELATED_LIMIT}`,
    )
    .bind(event.id, event.ray_id, JSON.stringify(traceIds))
    .all<{
      id: string;
      issue_id: string;
      project_id: string;
      ts: number;
      release: string | null;
      environment: string | null;
      url: string | null;
      user_agent: string | null;
      ray_id: string | null;
      trace_id: string | null;
      source: RelatedEvent["source"];
      type: string;
      message: string;
    }>();

  const related: Related = {
    rayId: event.ray_id ?? traceRows.find((t) => t.ray_id)?.ray_id ?? null,
    events: eventRows.map((r) => ({
      id: r.id,
      issueId: r.issue_id,
      projectId: r.project_id,
      ts: r.ts,
      release: r.release,
      environment: r.environment,
      url: r.url,
      userAgent: r.user_agent,
      rayId: r.ray_id,
      traceId: r.trace_id,
      source: r.source,
      type: r.type,
      message: r.message,
    })),
    traces: traceRows.map(toTraceSummary),
  };
  return c.json(related);
});
