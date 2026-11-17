import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type SubmitEvent, useState } from "react";
import type { Overview, Project } from "../../shared/types";
import { api } from "../api";
import { BarChart } from "../components/BarChart";
import { Empty, ErrorBox, Loading, Section } from "../components/ui";
import { count, relativeTime } from "../format";
import { Link, navigate, useTitle } from "../router";

export function OverviewPage() {
  useTitle("");
  const overview = useQuery({ queryKey: ["overview"], queryFn: () => api<Overview>("/overview") });
  const [creating, setCreating] = useState(false);

  if (overview.isPending) return <Loading />;
  if (overview.error) return <ErrorBox error={overview.error} />;
  const { projects, series } = overview.data;
  const total = series.reduce((s, [, n]) => s + n, 0);

  return (
    <div className="stack">
      <div className="page-head">
        <h1>概況</h1>
        <button type="button" className="btn primary" onClick={() => setCreating((v) => !v)}>
          {creating ? "閉じる" : "プロジェクトを作成"}
        </button>
      </div>

      {creating && <CreateProjectForm />}

      <Section title={`直近24時間のエラー ${count(total)} 件`}>
        <BarChart points={series} interval="hour" />
      </Section>

      <Section title="プロジェクト">
        {projects.length === 0 ? (
          <Empty>
            <p>まだプロジェクトがありません。</p>
            <p className="muted">「プロジェクトを作成」から最初のサイトを登録してください。</p>
          </Empty>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>名前</th>
                  <th className="num">未解決</th>
                  <th className="num">24時間</th>
                  <th>今日の取り込み</th>
                  <th>最終発生</th>
                </tr>
              </thead>
              <tbody>
                {projects.map((p) => {
                  const ratio = Math.min(1, p.eventsToday / p.dailyEventLimit);
                  return (
                    <tr key={p.id}>
                      <td>
                        <Link href={`/projects/${encodeURIComponent(p.id)}`} className="strong">
                          {p.name}
                        </Link>
                        <div className="muted small mono">{p.id}</div>
                      </td>
                      <td className="num">{count(p.unresolvedIssues)}</td>
                      <td className="num">{count(p.events24h)}</td>
                      <td>
                        <div className="usage">
                          <div
                            className={`usage-bar${ratio >= 1 ? " full" : ratio >= 0.8 ? " warn" : ""}`}
                            style={{ width: `${ratio * 100}%` }}
                          />
                        </div>
                        <div className="muted small">
                          {count(p.eventsToday)} / {count(p.dailyEventLimit)}
                        </div>
                      </td>
                      <td className="muted">{p.lastSeen ? relativeTime(p.lastSeen) : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </div>
  );
}

function CreateProjectForm() {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [id, setId] = useState("");
  const [origins, setOrigins] = useState("");

  const create = useMutation({
    mutationFn: () =>
      api<Project>("/projects", {
        method: "POST",
        body: JSON.stringify({
          name,
          id: id || undefined,
          allowedOrigins: origins
            .split(/\s+/)
            .map((s) => s.trim())
            .filter(Boolean),
        }),
      }),
    onSuccess: async (p) => {
      await qc.invalidateQueries({ queryKey: ["projects"] });
      await qc.invalidateQueries({ queryKey: ["overview"] });
      navigate(`/projects/${encodeURIComponent(p.id)}/settings`);
    },
  });

  const submit = (e: SubmitEvent) => {
    e.preventDefault();
    create.mutate();
  };

  return (
    <Section title="プロジェクトを作成">
      <form className="form" onSubmit={submit}>
        <label>
          <span>名前</span>
          <input
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="My Site"
          />
        </label>
        <label>
          <span>ID（省略時は名前から作る。ソースマップのアップロードで使う）</span>
          <input
            value={id}
            onChange={(e) => setId(e.target.value)}
            placeholder="my-site"
            pattern="[a-z0-9][a-z0-9\-]*"
          />
        </label>
        <label>
          <span>許可する Origin（1行に1つ）</span>
          <textarea
            rows={3}
            value={origins}
            onChange={(e) => setOrigins(e.target.value)}
            placeholder="https://example.com"
          />
        </label>
        <ErrorBox error={create.error} />
        <div>
          <button type="submit" className="btn primary" disabled={create.isPending}>
            作成
          </button>
        </div>
      </form>
    </Section>
  );
}
