-- プロジェクトごとの1日の取り込み件数。受信口が1日の上限（daily_event_limit）の判定に使う
CREATE TABLE project_usage (
  project_id TEXT NOT NULL,
  day        TEXT NOT NULL,   -- UTC の yyyy-mm-dd
  count      INTEGER NOT NULL,
  PRIMARY KEY (project_id, day)
);
