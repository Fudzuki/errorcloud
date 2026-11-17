// Worker とダッシュボードで共有する型。時刻はすべて UNIX ミリ秒（issue_buckets.bucket_start だけ UNIX 秒）。

export type IssueStatus = "unresolved" | "resolved" | "ignored";
export const ISSUE_STATUSES: readonly IssueStatus[] = ["unresolved", "resolved", "ignored"];

/** ブラウザSDKが送るリクエスト本文（技術定義書 2章「イベントの形」） */
export type BrowserPayload = {
  key: string;
  release?: string;
  environment?: string;
  events: BrowserEvent[];
};

/** ブラウザ由来の4種と、Workerのログ・スパン由来（段階3） */
export type EventKind = "error" | "unhandledrejection" | "fetch" | "manual" | "log" | "span";

export type EventSource = "browser" | "worker";

export type BrowserEvent = {
  ts: number;
  type: string;
  message: string;
  stack?: string;
  url?: string;
  kind: EventKind;
  request?: { url?: string; method?: string; status?: number; rayId?: string };
  /** SDK 側で明示したフィンガープリント */
  fingerprint?: string[];
  /** beforeSend などで利用者が付けた追加情報 */
  extra?: Record<string, unknown>;
};

export type StackFrame = {
  function?: string;
  file: string;
  line?: number;
  column?: number;
  inApp: boolean;
};

/** R2 に保存するイベント本体 */
export type StoredEvent = {
  id: string;
  projectId: string;
  issueId: string;
  receivedAt: number;
  release?: string;
  environment?: string;
  userAgent?: string;
  /** 未指定なら browser（段階1で保存したもの） */
  source?: EventSource;
  /** Worker 由来のイベントの付帯情報（段階3） */
  worker?: { name: string; traceId?: string; spanId?: string };
  event: BrowserEvent;
  frames: StackFrame[];
};

export type Project = {
  id: string;
  name: string;
  publicKey: string;
  allowedOrigins: string[];
  retentionDays: number;
  dailyEventLimit: number;
  createdAt: number;
};

export type ProjectInput = {
  id?: string;
  name?: string;
  allowedOrigins?: string[];
  retentionDays?: number;
  dailyEventLimit?: number;
  /** true なら公開キーを再発行する（PATCH のみ） */
  rotateKey?: boolean;
};

export type OverviewProject = {
  id: string;
  name: string;
  unresolvedIssues: number;
  events24h: number;
  eventsToday: number;
  dailyEventLimit: number;
  lastSeen: number | null;
};

export type Overview = {
  projects: OverviewProject[];
  /** 全プロジェクト合計の直近24時間の件数。[bucket_start(秒), count] */
  series: [number, number][];
};

export type Issue = {
  id: string;
  projectId: string;
  source: EventSource;
  type: string;
  message: string;
  culprit: string | null;
  status: IssueStatus;
  firstSeen: number;
  lastSeen: number;
  eventCount: number;
};

export type Page<T> = { items: T[]; nextCursor: string | null };

export type IssueStats = {
  interval: "hour" | "day";
  /** [区間の先頭(秒), count] */
  points: [number, number][];
};

export type EventSummary = {
  id: string;
  issueId: string;
  ts: number;
  release: string | null;
  environment: string | null;
  url: string | null;
  userAgent: string | null;
  rayId: string | null;
  traceId: string | null;
};

export type ApiError = { error: string };

// ---------------------------------------------------------------- Worker（段階3）

export type WorkerMapping = {
  name: string;
  /** null なら未割り当て */
  projectId: string | null;
  firstSeen: number;
  lastSeen: number | null;
  /** 届いたエラーイベントの累計（未割り当てのあいだに捨てた分を含む） */
  eventCount: number;
};

// ---------------------------------------------------------------- トレース（段階3・4）

export type SpanStatus = "unset" | "ok" | "error";
export type AttrValue = string | number | boolean;

export type SpanRecord = {
  spanId: string;
  parentSpanId?: string;
  name: string;
  /** UNIX ミリ秒 */
  start: number;
  end: number;
  status: SpanStatus;
  statusMessage?: string;
  attributes: Record<string, AttrValue>;
  events?: { name: string; ts: number; attributes: Record<string, AttrValue> }[];
};

/** R2 に保存するトレース本体 */
export type StoredTrace = {
  traceId: string;
  projectId: string;
  worker: string;
  rayId?: string;
  start: number;
  durationMs: number;
  spans: SpanRecord[];
};

export type TraceSummary = {
  traceId: string;
  projectId: string;
  worker: string;
  ts: number;
  durationMs: number | null;
  hasError: boolean;
  rayId: string | null;
};

/** GET /api/events/:id/related の応答（段階4） */
export type RelatedEvent = EventSummary & {
  projectId: string;
  source: EventSource;
  type: string;
  message: string;
};

export type Related = {
  rayId: string | null;
  events: RelatedEvent[];
  traces: TraceSummary[];
};
