-- 技術定義書 4章「D1スキーマ」
CREATE TABLE projects (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  public_key        TEXT NOT NULL UNIQUE,
  allowed_origins   TEXT NOT NULL DEFAULT '[]',   -- JSON配列
  retention_days    INTEGER NOT NULL DEFAULT 90,
  daily_event_limit INTEGER NOT NULL DEFAULT 5000,
  created_at        INTEGER NOT NULL
);

-- OTLPで届いたWorker名とプロジェクトの対応。project_idがNULLなら未割り当て
CREATE TABLE project_workers (
  worker_name TEXT PRIMARY KEY,
  project_id  TEXT REFERENCES projects(id),
  first_seen  INTEGER NOT NULL
);

CREATE TABLE issues (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id),
  fingerprint TEXT NOT NULL,
  source      TEXT NOT NULL,                       -- 'browser' | 'worker'
  type        TEXT NOT NULL,
  message     TEXT NOT NULL,
  culprit     TEXT,                                -- 最上位フレームのファイル名
  status      TEXT NOT NULL DEFAULT 'unresolved',  -- 'unresolved' | 'resolved' | 'ignored'
  first_seen  INTEGER NOT NULL,
  last_seen   INTEGER NOT NULL,
  event_count INTEGER NOT NULL DEFAULT 0,
  UNIQUE (project_id, fingerprint)
);
CREATE INDEX idx_issues_list ON issues (project_id, status, last_seen DESC);

-- サンプリングして保存したイベントの索引。本体はR2
CREATE TABLE events (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL,
  issue_id    TEXT NOT NULL REFERENCES issues(id),
  ts          INTEGER NOT NULL,
  release     TEXT,
  environment TEXT,
  url         TEXT,
  user_agent  TEXT,
  ray_id      TEXT,
  trace_id    TEXT,
  r2_key      TEXT NOT NULL
);
CREATE INDEX idx_events_issue ON events (issue_id, ts DESC);
CREATE INDEX idx_events_ray   ON events (project_id, ray_id);

-- グラフ用の1時間単位の件数
CREATE TABLE issue_buckets (
  issue_id     TEXT NOT NULL,
  project_id   TEXT NOT NULL,
  bucket_start INTEGER NOT NULL,   -- 時の先頭のUNIX秒
  count        INTEGER NOT NULL,
  PRIMARY KEY (issue_id, bucket_start)
);
CREATE INDEX idx_buckets_project ON issue_buckets (project_id, bucket_start);

CREATE TABLE traces (
  trace_id    TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL,
  worker_name TEXT NOT NULL,
  ts          INTEGER NOT NULL,
  duration_ms INTEGER,
  has_error   INTEGER NOT NULL DEFAULT 0,
  ray_id      TEXT,
  r2_key      TEXT NOT NULL
);
CREATE INDEX idx_traces_ray ON traces (project_id, ray_id);

CREATE TABLE releases (
  project_id TEXT NOT NULL,
  release    TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, release)
);
