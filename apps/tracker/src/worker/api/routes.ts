// 管理用API（技術定義書 5章）。/api/* は Cloudflare Access の内側に置く。
import { Hono } from "hono";
import {
  type EventSummary,
  ISSUE_STATUSES,
  type Issue,
  type IssueStats,
  type IssueStatus,
  type Overview,
  type Page,
  type ProjectInput,
} from "../../shared/types";
import type { AppEnv } from "../env";
import {
  dayOf,
  generatePublicKey,
  invalidateProjectCache,
  type ProjectRow,
  toProject,
} from "../projects";
import { deleteProjectData, deleteProjectObjects } from "../retention";

export const api = new Hono<{ Bindings: AppEnv }>();

const HOUR = 3600;

// ---------------------------------------------------------------- 共通

type IssueRow = {
  id: string;
  project_id: string;
  source: "browser" | "worker";
  type: string;
  message: string;
  culprit: string | null;
  status: IssueStatus;
  first_seen: number;
  last_seen: number;
  event_count: number;
};

function toIssue(r: IssueRow): Issue {
  return {
    id: r.id,
    projectId: r.project_id,
    source: r.source,
    type: r.type,
    message: r.message,
    culprit: r.culprit,
    status: r.status,
    firstSeen: r.first_seen,
    lastSeen: r.last_seen,
    eventCount: r.event_count,
  };
}

type EventRow = {
  id: string;
  issue_id: string;
  ts: number;
  release: string | null;
  environment: string | null;
  url: string | null;
  user_agent: string | null;
  ray_id: string | null;
  r2_key: string;
};

function toEventSummary(r: EventRow): EventSummary {
  return {
    id: r.id,
    issueId: r.issue_id,
    ts: r.ts,
    release: r.release,
    environment: r.environment,
    url: r.url,
    userAgent: r.user_agent,
    rayId: r.ray_id,
  };
}

function encodeCursor(ts: number, id: string): string {
  return btoa(JSON.stringify([ts, id])).replace(/=+$/, "");
}

function decodeCursor(raw: string | undefined): [number, string] | null {
  if (!raw) return null;
  try {
    const v: unknown = JSON.parse(atob(raw));
    if (Array.isArray(v) && typeof v[0] === "number" && typeof v[1] === "string") {
      return [v[0], v[1]];
    }
  } catch {
    // 不正なカーソルは先頭からとして扱う
  }
  return null;
}

function limitParam(raw: string | undefined, def: number, max: number): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? Math.min(n, max) : def;
}

function numParam(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

// ---------------------------------------------------------------- プロジェクト入力の検証

const PROJECT_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

function normalizeOrigin(raw: string): string | null {
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

type Validated = {
  name?: string;
  allowedOrigins?: string[];
  retentionDays?: number;
  dailyEventLimit?: number;
};

function validateProjectInput(body: ProjectInput): Validated | string {
  const out: Validated = {};
  if (body.name !== undefined) {
    if (typeof body.name !== "string" || !body.name.trim() || body.name.length > 100) {
      return "name は1〜100文字で指定してください";
    }
    out.name = body.name.trim();
  }
  if (body.allowedOrigins !== undefined) {
    if (!Array.isArray(body.allowedOrigins)) return "allowedOrigins は配列で指定してください";
    const origins: string[] = [];
    for (const o of body.allowedOrigins) {
      const n = typeof o === "string" ? normalizeOrigin(o) : null;
      if (!n) return `Origin の形式が正しくありません: ${String(o)}`;
      if (!origins.includes(n)) origins.push(n);
    }
    out.allowedOrigins = origins;
  }
  if (body.retentionDays !== undefined) {
    const v = body.retentionDays;
    if (!Number.isInteger(v) || v < 1 || v > 365) return "retentionDays は1〜365の整数です";
    out.retentionDays = v;
  }
  if (body.dailyEventLimit !== undefined) {
    const v = body.dailyEventLimit;
    if (!Number.isInteger(v) || v < 1 || v > 10_000_000) {
      return "dailyEventLimit は1以上の整数です";
    }
    out.dailyEventLimit = v;
  }
  return out;
}

async function readJson<T>(req: Request): Promise<T | null> {
  try {
    return (await req.json()) as T;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- 概況

api.get("/overview", async (c) => {
  const now = Date.now();
  const since = Math.floor(now / 1000 / HOUR) * HOUR - 23 * HOUR;
  const db = c.env.DB;
  const [projects, unresolved, recent, today, series] = await db.batch([
    db.prepare("SELECT id, name, daily_event_limit FROM projects ORDER BY name"),
    db.prepare(
      `SELECT project_id, COUNT(*) AS n, MAX(last_seen) AS last_seen
         FROM issues WHERE status = 'unresolved' GROUP BY project_id`,
    ),
    db
      .prepare(
        `SELECT project_id, SUM(count) AS n FROM issue_buckets
          WHERE bucket_start >= ? GROUP BY project_id`,
      )
      .bind(since),
    db.prepare("SELECT project_id, count AS n FROM project_usage WHERE day = ?").bind(dayOf(now)),
    db
      .prepare(
        `SELECT bucket_start, SUM(count) AS n FROM issue_buckets
          WHERE bucket_start >= ? GROUP BY bucket_start`,
      )
      .bind(since),
  ]);

  type Count = { project_id: string; n: number; last_seen?: number };
  const byProject = (r: D1Result<unknown> | undefined) =>
    new Map(((r?.results ?? []) as Count[]).map((x) => [x.project_id, x]));
  const u = byProject(unresolved);
  const r = byProject(recent);
  const t = byProject(today);

  const points = new Map(
    ((series?.results ?? []) as { bucket_start: number; n: number }[]).map((x) => [
      x.bucket_start,
      x.n,
    ]),
  );
  const out: Overview = {
    projects: (
      (projects?.results ?? []) as { id: string; name: string; daily_event_limit: number }[]
    ).map((p) => ({
      id: p.id,
      name: p.name,
      unresolvedIssues: u.get(p.id)?.n ?? 0,
      events24h: r.get(p.id)?.n ?? 0,
      eventsToday: t.get(p.id)?.n ?? 0,
      dailyEventLimit: p.daily_event_limit,
      lastSeen: u.get(p.id)?.last_seen ?? null,
    })),
    series: Array.from({ length: 24 }, (_, i) => {
      const at = since + i * HOUR;
      return [at, points.get(at) ?? 0] as [number, number];
    }),
  };
  return c.json(out);
});

// ---------------------------------------------------------------- プロジェクト

api.get("/projects", async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT * FROM projects ORDER BY name",
  ).all<ProjectRow>();
  return c.json(results.map(toProject));
});

api.post("/projects", async (c) => {
  const body = await readJson<ProjectInput>(c.req.raw);
  if (!body) return c.json({ error: "JSON を送ってください" }, 400);
  if (body.name === undefined) return c.json({ error: "name は必須です" }, 400);
  const v = validateProjectInput(body);
  if (typeof v === "string") return c.json({ error: v }, 400);

  let id = body.id ?? slugify(v.name ?? "");
  if (!id) id = `p-${crypto.randomUUID().slice(0, 8)}`;
  if (!PROJECT_ID.test(id)) {
    return c.json({ error: "id は英小文字・数字・ハイフンで指定してください" }, 400);
  }
  const exists = await c.env.DB.prepare("SELECT 1 FROM projects WHERE id = ?").bind(id).first();
  if (exists) return c.json({ error: `id "${id}" はすでに使われています` }, 409);

  const row: ProjectRow = {
    id,
    name: v.name ?? id,
    public_key: generatePublicKey(),
    allowed_origins: JSON.stringify(v.allowedOrigins ?? []),
    retention_days: v.retentionDays ?? 90,
    daily_event_limit: v.dailyEventLimit ?? 5000,
    created_at: Date.now(),
  };
  await c.env.DB.prepare(
    `INSERT INTO projects
       (id, name, public_key, allowed_origins, retention_days, daily_event_limit, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      row.id,
      row.name,
      row.public_key,
      row.allowed_origins,
      row.retention_days,
      row.daily_event_limit,
      row.created_at,
    )
    .run();
  return c.json(toProject(row), 201);
});

api.patch("/projects/:id", async (c) => {
  const id = c.req.param("id");
  const current = await c.env.DB.prepare("SELECT * FROM projects WHERE id = ?")
    .bind(id)
    .first<ProjectRow>();
  if (!current) return c.json({ error: "not found" }, 404);

  const body = await readJson<ProjectInput>(c.req.raw);
  if (!body) return c.json({ error: "JSON を送ってください" }, 400);
  const v = validateProjectInput(body);
  if (typeof v === "string") return c.json({ error: v }, 400);

  const next: ProjectRow = {
    ...current,
    name: v.name ?? current.name,
    allowed_origins:
      v.allowedOrigins !== undefined ? JSON.stringify(v.allowedOrigins) : current.allowed_origins,
    retention_days: v.retentionDays ?? current.retention_days,
    daily_event_limit: v.dailyEventLimit ?? current.daily_event_limit,
    public_key: body.rotateKey === true ? generatePublicKey() : current.public_key,
  };
  await c.env.DB.prepare(
    `UPDATE projects SET name = ?, public_key = ?, allowed_origins = ?, retention_days = ?,
            daily_event_limit = ? WHERE id = ?`,
  )
    .bind(
      next.name,
      next.public_key,
      next.allowed_origins,
      next.retention_days,
      next.daily_event_limit,
      id,
    )
    .run();
  invalidateProjectCache();
  return c.json(toProject(next));
});

api.delete("/projects/:id", async (c) => {
  const id = c.req.param("id");
  const exists = await c.env.DB.prepare("SELECT 1 FROM projects WHERE id = ?").bind(id).first();
  if (!exists) return c.json({ error: "not found" }, 404);
  await deleteProjectData(c.env, id);
  invalidateProjectCache();
  // R2 のオブジェクトは件数が多いことがあるので、レスポンスを返した後に消す
  c.executionCtx.waitUntil(deleteProjectObjects(c.env, id));
  return c.body(null, 204);
});

/** 絞り込みの候補（環境とリリース） */
api.get("/projects/:id/facets", async (c) => {
  const id = c.req.param("id");
  const db = c.env.DB;
  const [envs, rels] = await db.batch([
    db
      .prepare(
        `SELECT DISTINCT environment AS v FROM events
          WHERE project_id = ? AND environment IS NOT NULL ORDER BY v LIMIT 50`,
      )
      .bind(id),
    db
      .prepare(
        "SELECT release AS v FROM releases WHERE project_id = ? ORDER BY created_at DESC LIMIT 50",
      )
      .bind(id),
  ]);
  const values = (r: D1Result<unknown> | undefined) =>
    ((r?.results ?? []) as { v: string }[]).map((x) => x.v);
  return c.json({ environments: values(envs), releases: values(rels) });
});

// ---------------------------------------------------------------- issue

api.get("/projects/:id/issues", async (c) => {
  const projectId = c.req.param("id");
  const q = c.req.query();
  const limit = limitParam(q.limit, 25, 100);
  const where = ["project_id = ?"];
  const params: (string | number)[] = [projectId];

  if (q.status) {
    if (!ISSUE_STATUSES.includes(q.status as IssueStatus)) {
      return c.json({ error: "status が正しくありません" }, 400);
    }
    where.push("status = ?");
    params.push(q.status);
  }
  const from = numParam(q.from);
  if (from !== undefined) {
    where.push("last_seen >= ?");
    params.push(from);
  }
  const to = numParam(q.to);
  if (to !== undefined) {
    where.push("first_seen <= ?");
    params.push(to);
  }
  // 環境とリリースは、保存済み（サンプリング済み）のイベントで判定する
  if (q.environment) {
    where.push(
      "EXISTS (SELECT 1 FROM events e WHERE e.issue_id = issues.id AND e.environment = ?)",
    );
    params.push(q.environment);
  }
  if (q.release) {
    where.push("EXISTS (SELECT 1 FROM events e WHERE e.issue_id = issues.id AND e.release = ?)");
    params.push(q.release);
  }
  const cursor = decodeCursor(q.cursor);
  if (cursor) {
    where.push("(last_seen < ? OR (last_seen = ? AND id < ?))");
    params.push(cursor[0], cursor[0], cursor[1]);
  }

  const { results } = await c.env.DB.prepare(
    `SELECT * FROM issues WHERE ${where.join(" AND ")} ORDER BY last_seen DESC, id DESC LIMIT ?`,
  )
    .bind(...params, limit + 1)
    .all<IssueRow>();
  const items = results.slice(0, limit).map(toIssue);
  const last = items.at(-1);
  const page: Page<Issue> = {
    items,
    nextCursor: results.length > limit && last ? encodeCursor(last.lastSeen, last.id) : null,
  };
  return c.json(page);
});

api.get("/issues/:id", async (c) => {
  const row = await c.env.DB.prepare("SELECT * FROM issues WHERE id = ?")
    .bind(c.req.param("id"))
    .first<IssueRow>();
  if (!row) return c.json({ error: "not found" }, 404);
  return c.json(toIssue(row));
});

api.patch("/issues/:id", async (c) => {
  const body = await readJson<{ status?: string }>(c.req.raw);
  const status = body?.status as IssueStatus | undefined;
  if (!status || !ISSUE_STATUSES.includes(status)) {
    return c.json({ error: "status は unresolved / resolved / ignored のいずれかです" }, 400);
  }
  const row = await c.env.DB.prepare("UPDATE issues SET status = ? WHERE id = ? RETURNING *")
    .bind(status, c.req.param("id"))
    .first<IssueRow>();
  if (!row) return c.json({ error: "not found" }, 404);
  return c.json(toIssue(row));
});

const RANGES: Record<string, { hours: number; interval: "hour" | "day" }> = {
  "24h": { hours: 24, interval: "hour" },
  "7d": { hours: 24 * 7, interval: "hour" },
  "30d": { hours: 24 * 30, interval: "day" },
  "90d": { hours: 24 * 90, interval: "day" },
};

api.get("/issues/:id/stats", async (c) => {
  const range = RANGES[c.req.query("range") ?? "24h"];
  if (!range) return c.json({ error: "range は 24h / 7d / 30d / 90d のいずれかです" }, 400);
  const step = range.interval === "hour" ? HOUR : 24 * HOUR;
  const end = Math.floor(Date.now() / 1000 / step) * step;
  const start = end - (Math.ceil(range.hours / (step / HOUR)) - 1) * step;

  const { results } = await c.env.DB.prepare(
    `SELECT CAST(bucket_start / ? AS INTEGER) * ? AS at, SUM(count) AS n FROM issue_buckets
      WHERE issue_id = ? AND bucket_start >= ? GROUP BY at`,
  )
    .bind(step, step, c.req.param("id"), start)
    .all<{ at: number; n: number }>();
  const byAt = new Map(results.map((r) => [r.at, r.n]));
  const points: [number, number][] = [];
  for (let at = start; at <= end; at += step) points.push([at, byAt.get(at) ?? 0]);
  const stats: IssueStats = { interval: range.interval, points };
  return c.json(stats);
});

api.get("/issues/:id/events", async (c) => {
  const limit = limitParam(c.req.query("limit"), 20, 100);
  const cursor = decodeCursor(c.req.query("cursor"));
  const params: (string | number)[] = [c.req.param("id")];
  let extra = "";
  if (cursor) {
    extra = "AND (ts < ? OR (ts = ? AND id < ?))";
    params.push(cursor[0], cursor[0], cursor[1]);
  }
  const { results } = await c.env.DB.prepare(
    `SELECT * FROM events WHERE issue_id = ? ${extra} ORDER BY ts DESC, id DESC LIMIT ?`,
  )
    .bind(...params, limit + 1)
    .all<EventRow>();
  const items = results.slice(0, limit).map(toEventSummary);
  const last = items.at(-1);
  const page: Page<EventSummary> = {
    items,
    nextCursor: results.length > limit && last ? encodeCursor(last.ts, last.id) : null,
  };
  return c.json(page);
});

// ---------------------------------------------------------------- イベント

api.get("/events/:id", async (c) => {
  const row = await c.env.DB.prepare("SELECT r2_key FROM events WHERE id = ?")
    .bind(c.req.param("id"))
    .first<{ r2_key: string }>();
  if (!row) return c.json({ error: "not found" }, 404);
  const obj = await c.env.BUCKET.get(row.r2_key);
  if (!obj)
    return c.json({ error: "イベント本体が見つかりません（保持期間切れの可能性があります）" }, 404);
  return new Response(obj.body, { headers: { "Content-Type": "application/json" } });
});
