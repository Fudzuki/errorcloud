// OTLP で届いた Worker とプロジェクトの対応（技術定義書 5章、段階3）
import { Hono } from "hono";
import type { WorkerMapping } from "../../shared/types";
import type { AppEnv } from "../env";

export const workers = new Hono<{ Bindings: AppEnv }>();

type WorkerRow = {
  worker_name: string;
  project_id: string | null;
  first_seen: number;
  last_seen: number | null;
  event_count: number;
};

function toWorker(r: WorkerRow): WorkerMapping {
  return {
    name: r.worker_name,
    projectId: r.project_id,
    firstSeen: r.first_seen,
    lastSeen: r.last_seen,
    eventCount: r.event_count,
  };
}

const WORKER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;

/** すべての Worker。?project= でプロジェクトに割り当て済みのものに絞る */
workers.get("/", async (c) => {
  const project = c.req.query("project");
  const stmt = project
    ? c.env.DB.prepare(
        "SELECT * FROM project_workers WHERE project_id = ? ORDER BY worker_name",
      ).bind(project)
    : c.env.DB.prepare("SELECT * FROM project_workers ORDER BY worker_name");
  const { results } = await stmt.all<WorkerRow>();
  return c.json(results.map(toWorker));
});

workers.get("/unassigned", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT * FROM project_workers WHERE project_id IS NULL
      ORDER BY COALESCE(last_seen, first_seen) DESC LIMIT 200`,
  ).all<WorkerRow>();
  return c.json(results.map(toWorker));
});

/**
 * Worker をプロジェクトに割り当てる。projectId に null を渡すと割り当てを外す。
 * まだデータが届いていない Worker 名も先に登録できる。
 */
workers.put("/:name", async (c) => {
  const name = c.req.param("name");
  if (!WORKER_NAME.test(name)) return c.json({ error: "Worker 名の形式が正しくありません" }, 400);
  let body: { projectId?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "JSON を送ってください" }, 400);
  }
  const projectId = body.projectId;
  if (projectId !== null && typeof projectId !== "string") {
    return c.json({ error: "projectId は文字列か null で指定してください" }, 400);
  }
  if (projectId !== null) {
    const exists = await c.env.DB.prepare("SELECT 1 FROM projects WHERE id = ?")
      .bind(projectId)
      .first();
    if (!exists) return c.json({ error: `プロジェクト「${projectId}」はありません` }, 404);
  }
  const row = await c.env.DB.prepare(
    `INSERT INTO project_workers (worker_name, project_id, first_seen) VALUES (?, ?, ?)
     ON CONFLICT (worker_name) DO UPDATE SET project_id = excluded.project_id
     RETURNING *`,
  )
    .bind(name, projectId, Date.now())
    .first<WorkerRow>();
  if (!row) return c.json({ error: "保存できませんでした" }, 500);
  return c.json(toWorker(row));
});

workers.delete("/:name", async (c) => {
  await c.env.DB.prepare("DELETE FROM project_workers WHERE worker_name = ?")
    .bind(c.req.param("name"))
    .run();
  return c.body(null, 204);
});
