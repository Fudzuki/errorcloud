// Queueコンシューマ（技術定義書 3章「コンシューマ」）。
// イベントごとに書き込まず、バッチ内で issue ごとに集計してから D1 の batch() で1回にまとめて書く。
import type { BrowserEvent, StackFrame, StoredEvent } from "../../shared/types";
import type { AppEnv, IngestMessage } from "../env";
import { parsePayload } from "../ingest/payload";
import { dayOf } from "../projects";
import {
  culpritOf,
  dropReason,
  fingerprintOf,
  issueIdOf,
  parseStack,
  sanitizeEvent,
} from "./normalize";

/** issue ごとに1時間あたり本体を保存するイベント数（技術定義書 3章「サンプリングと上限」） */
export const SAMPLES_PER_ISSUE_HOUR = 10;

type Prepared = {
  id: string;
  projectId: string;
  issueId: string;
  receivedAt: number;
  hour: number;
  release?: string;
  environment?: string;
  userAgent?: string;
  event: BrowserEvent;
  frames: StackFrame[];
};

type IssueAgg = {
  id: string;
  projectId: string;
  fingerprint: string;
  type: string;
  message: string;
  culprit: string | null;
  count: number;
  firstSeen: number;
  lastSeen: number;
};

export type BatchResult = { accepted: number; dropped: number; sampled: number };

export function eventR2Key(projectId: string, receivedAt: number, eventId: string): string {
  return `events/${projectId}/${dayOf(receivedAt)}/${eventId}.json`;
}

export async function processMessages(
  env: AppEnv,
  messages: readonly IngestMessage[],
): Promise<BatchResult> {
  const result: BatchResult = { accepted: 0, dropped: 0, sampled: 0 };
  if (messages.length === 0) return result;

  // 受信後に削除されたプロジェクトのメッセージは捨てる（外部キー違反でバッチ全体が失敗しないように）
  const projectIds = [...new Set(messages.map((m) => m.projectId))];
  const { results: existing } = await env.DB.prepare(
    "SELECT id FROM projects WHERE id IN (SELECT value FROM json_each(?))",
  )
    .bind(JSON.stringify(projectIds))
    .all<{ id: string }>();
  const liveProjects = new Set(existing.map((r) => r.id));

  // 1. 展開、除外、正規化、フィンガープリント
  const prepared: Prepared[] = [];
  const issues = new Map<string, IssueAgg>();
  for (const message of messages) {
    if (message.kind !== "browser" || !liveProjects.has(message.projectId)) continue;
    const payload = parsePayload(message.body);
    if (!payload) continue;
    for (const raw of payload.events) {
      if (dropReason(raw, message.userAgent)) {
        result.dropped++;
        continue;
      }
      const event = sanitizeEvent(raw);
      const frames = parseStack(event.stack, event.url);
      const culprit = culpritOf(frames);
      const fingerprint = await fingerprintOf(event, culprit);
      const issueId = await issueIdOf(message.projectId, fingerprint);
      // 時刻はクライアントの時計ではなく受信時刻を使う
      const receivedAt = message.receivedAt;

      prepared.push({
        id: crypto.randomUUID().replaceAll("-", ""),
        projectId: message.projectId,
        issueId,
        receivedAt,
        hour: Math.floor(receivedAt / 3_600_000) * 3600,
        release: payload.release,
        environment: payload.environment,
        userAgent: message.userAgent,
        event,
        frames,
      });

      const agg = issues.get(issueId);
      if (agg) {
        agg.count++;
        agg.firstSeen = Math.min(agg.firstSeen, receivedAt);
        agg.lastSeen = Math.max(agg.lastSeen, receivedAt);
      } else {
        issues.set(issueId, {
          id: issueId,
          projectId: message.projectId,
          fingerprint,
          type: event.type,
          message: event.message,
          culprit,
          count: 1,
          firstSeen: receivedAt,
          lastSeen: receivedAt,
        });
      }
    }
  }
  result.accepted = prepared.length;
  if (prepared.length === 0) return result;

  // 2. 時間バケットとプロジェクトの日次件数を集計
  const buckets = new Map<
    string,
    { issueId: string; projectId: string; hour: number; count: number }
  >();
  const usage = new Map<string, { projectId: string; day: string; count: number }>();
  const releases = new Map<string, { projectId: string; release: string; at: number }>();
  for (const p of prepared) {
    const bk = `${p.issueId}:${p.hour}`;
    const b = buckets.get(bk);
    if (b) b.count++;
    else buckets.set(bk, { issueId: p.issueId, projectId: p.projectId, hour: p.hour, count: 1 });

    const day = dayOf(p.receivedAt);
    const uk = `${p.projectId}:${day}`;
    const u = usage.get(uk);
    if (u) u.count++;
    else usage.set(uk, { projectId: p.projectId, day, count: 1 });

    if (p.release) {
      releases.set(`${p.projectId}:${p.release}`, {
        projectId: p.projectId,
        release: p.release,
        at: p.receivedAt,
      });
    }
  }

  // 3. サンプリング。この時間にすでに数えた件数を読み、合わせて10件に達するまで本体を残す
  const { results: existingBuckets } = await env.DB.prepare(
    `SELECT b.issue_id, b.bucket_start, b.count
       FROM json_each(?) j
       JOIN issue_buckets b
         ON b.issue_id = json_extract(j.value, '$[0]')
        AND b.bucket_start = json_extract(j.value, '$[1]')`,
  )
    .bind(JSON.stringify([...buckets.values()].map((b) => [b.issueId, b.hour])))
    .all<{ issue_id: string; bucket_start: number; count: number }>();
  const seen = new Map<string, number>(
    existingBuckets.map((r) => [`${r.issue_id}:${r.bucket_start}`, r.count]),
  );
  const sampled: Prepared[] = [];
  for (const p of prepared) {
    const bk = `${p.issueId}:${p.hour}`;
    const n = seen.get(bk) ?? 0;
    if (n < SAMPLES_PER_ISSUE_HOUR) sampled.push(p);
    seen.set(bk, n + 1);
  }
  result.sampled = sampled.length;

  // 4. 本体を先に R2 に置く。索引が存在しない本体を指さないように
  await Promise.all(
    sampled.map((p) => {
      const stored: StoredEvent = {
        id: p.id,
        projectId: p.projectId,
        issueId: p.issueId,
        receivedAt: p.receivedAt,
        release: p.release,
        environment: p.environment,
        userAgent: p.userAgent,
        event: p.event,
        frames: p.frames,
      };
      return env.BUCKET.put(eventR2Key(p.projectId, p.receivedAt, p.id), JSON.stringify(stored), {
        httpMetadata: { contentType: "application/json" },
      });
    }),
  );

  // 5. D1 にまとめて書く
  const db = env.DB;
  const statements: D1PreparedStatement[] = [];
  for (const i of issues.values()) {
    statements.push(
      db
        .prepare(
          `INSERT INTO issues
             (id, project_id, fingerprint, source, type, message, culprit, status,
              first_seen, last_seen, event_count)
           VALUES (?, ?, ?, 'browser', ?, ?, ?, 'unresolved', ?, ?, ?)
           ON CONFLICT (project_id, fingerprint) DO UPDATE SET
             event_count = event_count + excluded.event_count,
             first_seen  = MIN(first_seen, excluded.first_seen),
             last_seen   = MAX(last_seen, excluded.last_seen),
             status      = CASE WHEN status = 'resolved' THEN 'unresolved' ELSE status END`,
        )
        .bind(
          i.id,
          i.projectId,
          i.fingerprint,
          i.type,
          i.message,
          i.culprit,
          i.firstSeen,
          i.lastSeen,
          i.count,
        ),
    );
  }
  for (const b of buckets.values()) {
    statements.push(
      db
        .prepare(
          `INSERT INTO issue_buckets (issue_id, project_id, bucket_start, count) VALUES (?, ?, ?, ?)
           ON CONFLICT (issue_id, bucket_start) DO UPDATE SET count = count + excluded.count`,
        )
        .bind(b.issueId, b.projectId, b.hour, b.count),
    );
  }
  for (const p of sampled) {
    statements.push(
      db
        .prepare(
          `INSERT INTO events
             (id, project_id, issue_id, ts, release, environment, url, user_agent, ray_id, trace_id, r2_key)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
        )
        .bind(
          p.id,
          p.projectId,
          p.issueId,
          p.receivedAt,
          p.release ?? null,
          p.environment ?? null,
          p.event.url ?? null,
          p.userAgent ?? null,
          p.event.request?.rayId ?? null,
          eventR2Key(p.projectId, p.receivedAt, p.id),
        ),
    );
  }
  for (const u of usage.values()) {
    statements.push(
      db
        .prepare(
          `INSERT INTO project_usage (project_id, day, count) VALUES (?, ?, ?)
           ON CONFLICT (project_id, day) DO UPDATE SET count = count + excluded.count`,
        )
        .bind(u.projectId, u.day, u.count),
    );
  }
  for (const r of releases.values()) {
    statements.push(
      db
        .prepare(
          "INSERT OR IGNORE INTO releases (project_id, release, created_at) VALUES (?, ?, ?)",
        )
        .bind(r.projectId, r.release, r.at),
    );
  }
  await db.batch(statements);
  return result;
}
