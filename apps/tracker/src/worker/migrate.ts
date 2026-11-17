// D1 のマイグレーションを Worker 自身が適用する（技術定義書 9章「初回セットアップ」）。
// 適用済みの記録は wrangler と同じ d1_migrations テーブルに置くので、
// `wrangler d1 migrations apply` と併用しても二重に適用されない。

const files = import.meta.glob<string>("../../migrations/*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
});

export const MIGRATIONS = Object.entries(files)
  .map(([path, sql]) => ({ name: path.slice(path.lastIndexOf("/") + 1), sql }))
  .sort((a, b) => a.name.localeCompare(b.name));

/** コメントを除き、文ごとに分ける。マイグレーションに文字列リテラル内の ; や -- は書かない前提 */
export function splitStatements(sql: string): string[] {
  return sql
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n")
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

const CREATE_TABLE = `CREATE TABLE IF NOT EXISTS d1_migrations(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE,
  applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
)`;

async function applyPending(db: D1Database): Promise<void> {
  await db.prepare(CREATE_TABLE).run();
  const { results } = await db.prepare("SELECT name FROM d1_migrations").all<{ name: string }>();
  const applied = new Set(results.map((r) => r.name));
  for (const m of MIGRATIONS) {
    if (applied.has(m.name)) continue;
    // batch() は1つのトランザクションで実行されるので、途中で失敗しても半端に残らない
    await db.batch([
      ...splitStatements(m.sql).map((s) => db.prepare(s)),
      db.prepare("INSERT INTO d1_migrations (name) VALUES (?)").bind(m.name),
    ]);
  }
}

let pending: Promise<void> | undefined;

/** isolate ごとに1回だけ確認する。別の isolate と同時に適用して失敗したときは1度だけやり直す */
export function ensureMigrated(db: D1Database): Promise<void> {
  pending ??= applyPending(db)
    .catch(() => applyPending(db))
    .catch((err) => {
      pending = undefined;
      throw err;
    });
  return pending;
}
