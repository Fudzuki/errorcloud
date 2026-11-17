import type { Project } from "../shared/types";

export type ProjectRow = {
  id: string;
  name: string;
  public_key: string;
  allowed_origins: string;
  retention_days: number;
  daily_event_limit: number;
  created_at: number;
};

export function toProject(row: ProjectRow): Project {
  let origins: unknown;
  try {
    origins = JSON.parse(row.allowed_origins);
  } catch {
    origins = [];
  }
  return {
    id: row.id,
    name: row.name,
    publicKey: row.public_key,
    allowedOrigins: Array.isArray(origins)
      ? origins.filter((o): o is string => typeof o === "string")
      : [],
    retentionDays: row.retention_days,
    dailyEventLimit: row.daily_event_limit,
    createdAt: row.created_at,
  };
}

export function generatePublicKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return `pk_${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** UTC の yyyy-mm-dd */
export function dayOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------- 受信口用のキャッシュ

export type CachedProject = { project: Project; usedToday: number; day: string };

const TTL_MS = 30_000;
const MAX_ENTRIES = 1000;
const cache = new Map<string, { value: CachedProject | null; expires: number }>();

/**
 * 公開キーからプロジェクトと当日の取り込み件数を引く。受信のたびに D1 を読まないよう、
 * isolate 内に短時間キャッシュする（存在しないキーも覚えておく）。
 */
export async function projectForKey(
  db: D1Database,
  key: string,
  now = Date.now(),
): Promise<CachedProject | null> {
  const day = dayOf(now);
  const hit = cache.get(key);
  if (hit && hit.expires > now && (hit.value === null || hit.value.day === day)) return hit.value;

  const row = await db
    .prepare(
      `SELECT p.*, COALESCE(u.count, 0) AS used_today
         FROM projects p
         LEFT JOIN project_usage u ON u.project_id = p.id AND u.day = ?
        WHERE p.public_key = ?`,
    )
    .bind(day, key)
    .first<ProjectRow & { used_today: number }>();

  const value = row ? { project: toProject(row), usedToday: row.used_today, day } : null;
  if (cache.size >= MAX_ENTRIES) cache.clear();
  cache.set(key, { value, expires: now + TTL_MS });
  return value;
}

/** プロジェクトの編集・削除・キー再発行の後に呼ぶ（同じ isolate 内だけに効く） */
export function invalidateProjectCache(): void {
  cache.clear();
}
