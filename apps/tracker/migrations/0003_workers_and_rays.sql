-- 段階3・4: 未割り当てWorkerの表示用の項目と、Ray ID・トレースIDでの紐づけ用の索引
ALTER TABLE project_workers ADD COLUMN last_seen INTEGER;
ALTER TABLE project_workers ADD COLUMN event_count INTEGER NOT NULL DEFAULT 0;

-- Ray ID はプロジェクトをまたいで引く（ブラウザ側とWorker側が別プロジェクトのことがある）
CREATE INDEX idx_events_ray_id ON events (ray_id);
CREATE INDEX idx_events_trace  ON events (trace_id);
CREATE INDEX idx_traces_ray_id ON traces (ray_id);

-- cf-ray ヘッダーの末尾のデータセンター名（例: 8f0c1234abcd-NRT）を除いた形にそろえる
UPDATE events SET ray_id = lower(substr(ray_id, 1, instr(ray_id, '-') - 1)) WHERE instr(ray_id, '-') > 0
