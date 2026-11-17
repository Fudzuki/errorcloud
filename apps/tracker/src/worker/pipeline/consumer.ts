// Queueコンシューマ（技術定義書 3章「コンシューマ」）。
// イベントごとに書き込まず、バッチ内で issue ごとに集計してから D1 の batch() で1回にまとめて書く。
// ブラウザSDK（段階1、Sentry 互換の段階5を含む）と OTLP（段階3）のメッセージを同じ流れで扱う。
import type {
  BrowserEvent,
  EventSource,
  SpanRecord,
  StackFrame,
  StoredEvent,
  StoredTrace,
} from "../../shared/types";
import type { AppEnv, BrowserMessage, IngestMessage, WorkerMessage } from "../env";
import type { TraceRecord, WorkerEvent } from "../ingest/otlp";
import { parsePayload } from "../ingest/payload";
import { dayOf } from "../projects";
import {
  culpritOf,
  dropReason,
  fingerprintOf,
  issueIdOf,
  normalizeMessage,
  normalizeRayId,
  parseStack,
  parseWorkerStack,
  sanitizeEvent,
} from "./normalize";

/** issue ごとに1時間あたり本体を保存するイベント数（技術定義書 3章「サンプリングと上限」） */
export const SAMPLES_PER_ISSUE_HOUR = 10;
const MAX_SPANS_PER_TRACE = 1000;

type Prepared = {
  id: string;
  projectId: string;
  issueId: string;
  source: EventSource;
  receivedAt: number;
  hour: number;
  release?: string;
  environment?: string;
  userAgent?: string;
  rayId?: string;
  traceId?: string;
  worker?: StoredEvent["worker"];
  event: BrowserEvent;
  frames: StackFrame[];
};

type IssueAgg = {
  id: string;
  projectId: string;
  fingerprint: string;
  source: EventSource;
  type: string;
  message: string;
  culprit: string | null;
  count: number;
  firstSeen: number;
  lastSeen: number;
};

export type BatchResult = {
  accepted: number;
  dropped: number;
  sampled: number;
  /** 未割り当ての Worker から届いて捨てたイベント */
  unassigned: number;
  /** 保存（または追記）したトレース */
  traces: number;
};

export function eventR2Key(projectId: string, receivedAt: number, eventId: string): string {
  return `events/${projectId}/${dayOf(receivedAt)}/${eventId}.json`;
}

export function traceR2Key(projectId: string, start: number, traceId: string): string {
  return `traces/${projectId}/${dayOf(start)}/${traceId}.json`;
}

function newId(): string {
  return crypto.randomUUID().replaceAll("-", "");
}

export async function processMessages(
  env: AppEnv,
  messages: readonly IngestMessage[],
): Promise<BatchResult> {
  const result: BatchResult = { accepted: 0, dropped: 0, sampled: 0, unassigned: 0, traces: 0 };
  if (messages.length === 0) return result;
  const db = env.DB;

  const browserMessages = messages.filter((m): m is BrowserMessage => m.kind === "browser");
  const workerMessages = messages.filter((m): m is WorkerMessage => m.kind === "worker");

  // 受信後に削除されたプロジェクトのメッセージは捨てる（外部キー違反でバッチ全体が失敗しないように）
  const projectIds = [...new Set(browserMessages.map((m) => m.projectId))];
  const workerNames = [
    ...new Set(workerMessages.flatMap((m) => [...m.events, ...m.traces].map((x) => x.worker))),
  ];
  const [liveRows, workerRows] = await db.batch([
    db
      .prepare("SELECT id FROM projects WHERE id IN (SELECT value FROM json_each(?))")
      .bind(JSON.stringify(projectIds)),
    db
      .prepare(
        `SELECT w.worker_name, p.id AS project_id
           FROM project_workers w LEFT JOIN projects p ON p.id = w.project_id
          WHERE w.worker_name IN (SELECT value FROM json_each(?))`,
      )
      .bind(JSON.stringify(workerNames)),
  ]);
  const liveProjects = new Set(((liveRows?.results ?? []) as { id: string }[]).map((r) => r.id));
  const workerProject = new Map(
    ((workerRows?.results ?? []) as { worker_name: string; project_id: string | null }[]).map(
      (r) => [r.worker_name, r.project_id],
    ),
  );

  const prepared: Prepared[] = [];
  const issues = new Map<string, IssueAgg>();
  const addIssue = (p: Prepared, fingerprint: string, culprit: string | null) => {
    const agg = issues.get(p.issueId);
    if (agg) {
      agg.count++;
      agg.firstSeen = Math.min(agg.firstSeen, p.receivedAt);
      agg.lastSeen = Math.max(agg.lastSeen, p.receivedAt);
    } else {
      issues.set(p.issueId, {
        id: p.issueId,
        projectId: p.projectId,
        fingerprint,
        source: p.source,
        type: p.event.type,
        message: p.event.message,
        culprit,
        count: 1,
        firstSeen: p.receivedAt,
        lastSeen: p.receivedAt,
      });
    }
  };

  // 1a. ブラウザ: 展開、除外、正規化、フィンガープリント
  for (const message of browserMessages) {
    if (!liveProjects.has(message.projectId)) continue;
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
      // 時刻はクライアントの時計ではなく受信時刻を使う
      const receivedAt = message.receivedAt;
      const p: Prepared = {
        id: newId(),
        projectId: message.projectId,
        issueId: await issueIdOf(message.projectId, fingerprint),
        source: "browser",
        receivedAt,
        hour: Math.floor(receivedAt / 3_600_000) * 3600,
        release: payload.release,
        environment: payload.environment,
        userAgent: message.userAgent,
        rayId: normalizeRayId(event.request?.rayId),
        event,
        frames,
      };
      prepared.push(p);
      addIssue(p, fingerprint, culprit);
    }
  }

  // 1b. Worker: Worker 名からプロジェクトを引き、未割り当てなら件数だけ記録して捨てる
  const workerStats = new Map<string, { count: number; first: number; last: number }>();
  const touchWorker = (name: string, at: number, n: number) => {
    const s = workerStats.get(name);
    if (s) {
      s.count += n;
      s.first = Math.min(s.first, at);
      s.last = Math.max(s.last, at);
    } else workerStats.set(name, { count: n, first: at, last: at });
  };

  // ログには Ray ID が付かないことがある。同じトレースのスパンから補う
  const rayByTrace = new Map<string, string>();
  for (const m of workerMessages) {
    for (const x of [...m.traces, ...m.events]) {
      const ray = normalizeRayId(x.rayId);
      if (ray && x.traceId && !rayByTrace.has(x.traceId)) rayByTrace.set(x.traceId, ray);
    }
  }

  // 同じ例外がログとスパンの両方で届くことがあるので、トレースが同じなら1件にまとめる
  const seenInTrace = new Set<string>();
  for (const message of workerMessages) {
    for (const t of message.traces) touchWorker(t.worker, message.receivedAt, 0);
    for (const we of message.events) {
      touchWorker(we.worker, message.receivedAt, 1);
      const projectId = workerProject.get(we.worker);
      if (!projectId) {
        result.unassigned++;
        continue;
      }
      if (we.traceId) {
        const key = `${we.traceId}\n${we.type}\n${normalizeMessage(we.message)}`;
        if (seenInTrace.has(key)) {
          result.dropped++;
          continue;
        }
        seenInTrace.add(key);
      }
      const p = await prepareWorkerEvent(we, projectId, message.receivedAt, rayByTrace);
      prepared.push(p.prepared);
      addIssue(p.prepared, p.fingerprint, p.culprit);
    }
  }
  result.accepted = prepared.length;

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
  const sampled: Prepared[] = [];
  if (prepared.length > 0) {
    const { results: existingBuckets } = await db
      .prepare(
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
    for (const p of prepared) {
      const bk = `${p.issueId}:${p.hour}`;
      const n = seen.get(bk) ?? 0;
      if (n < SAMPLES_PER_ISSUE_HOUR) sampled.push(p);
      seen.set(bk, n + 1);
    }
  }
  result.sampled = sampled.length;

  // 4. トレース。保存したイベントが指すトレースと、すでに保存済みのトレースへの追記だけを残す
  const traces = await prepareTraces(env, workerMessages, workerProject, sampled, rayByTrace);
  result.traces = traces.length;

  // 5. 本体を先に R2 に置く。索引が存在しない本体を指さないように
  await Promise.all([
    ...sampled.map((p) => {
      const stored: StoredEvent = {
        id: p.id,
        projectId: p.projectId,
        issueId: p.issueId,
        receivedAt: p.receivedAt,
        release: p.release,
        environment: p.environment,
        userAgent: p.userAgent,
        source: p.source,
        worker: p.worker,
        event: p.event,
        frames: p.frames,
      };
      return env.BUCKET.put(eventR2Key(p.projectId, p.receivedAt, p.id), JSON.stringify(stored), {
        httpMetadata: { contentType: "application/json" },
      });
    }),
    ...traces.map((t) =>
      env.BUCKET.put(t.r2Key, JSON.stringify(t.stored), {
        httpMetadata: { contentType: "application/json" },
      }),
    ),
  ]);

  // 6. D1 にまとめて書く
  const statements: D1PreparedStatement[] = [];
  for (const i of issues.values()) {
    statements.push(
      db
        .prepare(
          `INSERT INTO issues
             (id, project_id, fingerprint, source, type, message, culprit, status,
              first_seen, last_seen, event_count)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'unresolved', ?, ?, ?)
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
          i.source,
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
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          p.rayId ?? null,
          p.traceId ?? null,
          eventR2Key(p.projectId, p.receivedAt, p.id),
        ),
    );
  }
  for (const t of traces) {
    statements.push(
      db
        .prepare(
          `INSERT INTO traces
             (trace_id, project_id, worker_name, ts, duration_ms, has_error, ray_id, r2_key)
           VALUES (?, ?, ?, ?, ?, 1, ?, ?)
           ON CONFLICT (trace_id) DO UPDATE SET
             ts          = MIN(ts, excluded.ts),
             duration_ms = excluded.duration_ms,
             ray_id      = COALESCE(ray_id, excluded.ray_id)`,
        )
        .bind(
          t.stored.traceId,
          t.stored.projectId,
          t.stored.worker,
          t.stored.start,
          t.stored.durationMs,
          normalizeRayId(t.stored.rayId) ?? null,
          t.r2Key,
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
  for (const [name, s] of workerStats) {
    statements.push(
      db
        .prepare(
          `INSERT INTO project_workers (worker_name, project_id, first_seen, last_seen, event_count)
           VALUES (?, NULL, ?, ?, ?)
           ON CONFLICT (worker_name) DO UPDATE SET
             last_seen   = MAX(COALESCE(last_seen, 0), excluded.last_seen),
             event_count = event_count + excluded.event_count`,
        )
        .bind(name, s.first, s.last, s.count),
    );
  }
  if (statements.length > 0) await db.batch(statements);
  return result;
}

// ---------------------------------------------------------------- Worker のイベント

async function prepareWorkerEvent(
  we: WorkerEvent,
  projectId: string,
  receivedAt: number,
  rayByTrace: Map<string, string>,
): Promise<{ prepared: Prepared; fingerprint: string; culprit: string | null }> {
  const rayId = normalizeRayId(we.rayId) ?? (we.traceId ? rayByTrace.get(we.traceId) : undefined);
  const event = sanitizeEvent({
    ts: we.ts,
    type: we.type,
    message: we.message,
    stack: we.stack,
    url: we.request?.url,
    kind: we.origin,
    request: we.request || rayId ? { ...we.request, rayId: we.rayId ?? rayId } : undefined,
    extra: we.attributes,
  });
  const frames = parseWorkerStack(event.stack);
  const file = culpritOf(frames);
  const fingerprint = await fingerprintOf(event, file, we.worker);
  return {
    prepared: {
      id: newId(),
      projectId,
      issueId: await issueIdOf(projectId, fingerprint),
      source: "worker",
      receivedAt,
      hour: Math.floor(receivedAt / 3_600_000) * 3600,
      rayId,
      traceId: we.traceId,
      worker: { name: we.worker, traceId: we.traceId, spanId: we.spanId },
      event,
      frames,
    },
    fingerprint,
    // 一覧でどの Worker のエラーか分かるよう、Worker 名を前に付ける
    culprit: file ? `${we.worker} · ${file}` : we.worker,
  };
}

// ---------------------------------------------------------------- トレース

type PreparedTrace = { stored: StoredTrace; r2Key: string };

function mergeSpans(a: SpanRecord[], b: SpanRecord[]): SpanRecord[] {
  const byId = new Map(a.map((s) => [s.spanId, s]));
  for (const s of b) if (!byId.has(s.spanId)) byId.set(s.spanId, s);
  return [...byId.values()].sort((x, y) => x.start - y.start).slice(0, MAX_SPANS_PER_TRACE);
}

function bounds(spans: SpanRecord[]): { start: number; durationMs: number } {
  const start = Math.min(...spans.map((s) => s.start));
  const end = Math.max(...spans.map((s) => s.end));
  return { start, durationMs: Math.max(0, end - start) };
}

async function prepareTraces(
  env: AppEnv,
  workerMessages: WorkerMessage[],
  workerProject: Map<string, string | null>,
  sampled: Prepared[],
  rayByTrace: Map<string, string>,
): Promise<PreparedTrace[]> {
  // バッチ内で同じトレースのスパンをまとめる
  const incoming = new Map<string, TraceRecord & { projectId: string }>();
  for (const m of workerMessages) {
    for (const t of m.traces) {
      const projectId = workerProject.get(t.worker);
      if (!projectId) continue;
      const cur = incoming.get(t.traceId);
      if (cur) {
        cur.spans = mergeSpans(cur.spans, t.spans);
        cur.rayId ??= t.rayId;
      } else incoming.set(t.traceId, { ...t, projectId });
    }
  }
  if (incoming.size === 0) return [];

  const { results: existing } = await env.DB.prepare(
    "SELECT trace_id, r2_key FROM traces WHERE trace_id IN (SELECT value FROM json_each(?))",
  )
    .bind(JSON.stringify([...incoming.keys()]))
    .all<{ trace_id: string; r2_key: string }>();
  const existingKey = new Map(existing.map((r) => [r.trace_id, r.r2_key]));
  // 保存するイベントが指すトレースだけを新しく保存する。イベントのサンプリング（issue ごとに
  // 1時間10件）がそのままトレースの上限になる
  const wanted = new Set(sampled.map((p) => p.traceId).filter(Boolean));

  const out: PreparedTrace[] = [];
  for (const t of incoming.values()) {
    const key = existingKey.get(t.traceId);
    if (!key && !wanted.has(t.traceId)) continue;
    let spans = t.spans;
    let rayId = t.rayId ?? rayByTrace.get(t.traceId);
    if (key) {
      const prev = await env.BUCKET.get(key);
      if (prev) {
        const stored = await prev.json<StoredTrace>();
        spans = mergeSpans(stored.spans, spans);
        rayId = stored.rayId ?? rayId;
      }
    }
    const { start, durationMs } = bounds(spans);
    out.push({
      stored: {
        traceId: t.traceId,
        projectId: t.projectId,
        worker: t.worker,
        rayId,
        start,
        durationMs,
        spans,
      },
      r2Key: key ?? traceR2Key(t.projectId, start, t.traceId),
    });
  }
  return out;
}
