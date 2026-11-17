// 保持期間の処理（技術定義書 4章）。Cron で1日1回動かす。
import type { AppEnv } from "./env";
import { dayOf } from "./projects";

const DAY_MS = 86_400_000;

/** prefix 以下のオブジェクトをすべて消す */
export async function deleteR2Prefix(bucket: R2Bucket, prefix: string): Promise<number> {
  let deleted = 0;
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, cursor, limit: 1000 });
    const keys = page.objects.map((o) => o.key);
    if (keys.length > 0) {
      await bucket.delete(keys);
      deleted += keys.length;
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return deleted;
}

/** `{kind}/{project_id}/` 直下の日付プレフィックスのうち、cutoffDay より前のものを消す */
async function deleteOldDays(
  bucket: R2Bucket,
  kind: "events" | "traces",
  projectId: string,
  cutoffDay: string,
): Promise<void> {
  const base = `${kind}/${projectId}/`;
  let cursor: string | undefined;
  const old: string[] = [];
  do {
    const page = await bucket.list({ prefix: base, delimiter: "/", cursor });
    for (const p of page.delimitedPrefixes) {
      const day = p.slice(base.length, -1);
      if (day < cutoffDay) old.push(p);
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  for (const prefix of old) await deleteR2Prefix(bucket, prefix);
}

export async function runRetention(env: AppEnv, now = Date.now()): Promise<void> {
  const { results: projects } = await env.DB.prepare(
    "SELECT id, retention_days FROM projects",
  ).all<{ id: string; retention_days: number }>();

  for (const p of projects) {
    const cutoff = now - p.retention_days * DAY_MS;
    const cutoffDay = dayOf(cutoff);
    await env.DB.batch([
      env.DB.prepare("DELETE FROM events WHERE project_id = ? AND ts < ?").bind(p.id, cutoff),
      env.DB.prepare("DELETE FROM issue_buckets WHERE project_id = ? AND bucket_start < ?").bind(
        p.id,
        Math.floor(cutoff / 1000),
      ),
      env.DB.prepare("DELETE FROM traces WHERE project_id = ? AND ts < ?").bind(p.id, cutoff),
      // issue 自体は最終発生が保持期間より古くなった時点で消す。索引は上で消えている
      env.DB.prepare(
        `DELETE FROM events WHERE issue_id IN
           (SELECT id FROM issues WHERE project_id = ? AND last_seen < ?)`,
      ).bind(p.id, cutoff),
      env.DB.prepare("DELETE FROM issues WHERE project_id = ? AND last_seen < ?").bind(
        p.id,
        cutoff,
      ),
      env.DB.prepare("DELETE FROM project_usage WHERE project_id = ? AND day < ?").bind(
        p.id,
        cutoffDay,
      ),
    ]);
    await deleteOldDays(env.BUCKET, "events", p.id, cutoffDay);
    await deleteOldDays(env.BUCKET, "traces", p.id, cutoffDay);
  }
}

/** プロジェクト削除時に、そのプロジェクトのデータをすべて消す */
export async function deleteProjectData(env: AppEnv, projectId: string): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM events WHERE project_id = ?").bind(projectId),
    env.DB.prepare("DELETE FROM issue_buckets WHERE project_id = ?").bind(projectId),
    env.DB.prepare("DELETE FROM traces WHERE project_id = ?").bind(projectId),
    env.DB.prepare("DELETE FROM issues WHERE project_id = ?").bind(projectId),
    env.DB.prepare("DELETE FROM releases WHERE project_id = ?").bind(projectId),
    env.DB.prepare("DELETE FROM project_usage WHERE project_id = ?").bind(projectId),
    env.DB.prepare("UPDATE project_workers SET project_id = NULL WHERE project_id = ?").bind(
      projectId,
    ),
    env.DB.prepare("DELETE FROM projects WHERE id = ?").bind(projectId),
  ]);
}

export async function deleteProjectObjects(env: AppEnv, projectId: string): Promise<void> {
  for (const kind of ["events", "traces", "sourcemaps"]) {
    await deleteR2Prefix(env.BUCKET, `${kind}/${projectId}/`);
  }
}
