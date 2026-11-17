import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type SubmitEvent, useState } from "react";
import type { Issue, Page, Project } from "../../shared/types";
import { api, query } from "../api";
import { Empty, ErrorBox, Loading, Section, StatusBadge } from "../components/ui";
import { count, relativeTime } from "../format";
import { useProject } from "../hooks";
import { Link, navigate, setSearch, useLocation, useTitle } from "../router";

type Props = { projectId: string; tab: "issues" | "settings" };

export function ProjectPage({ projectId, tab }: Props) {
  const project = useProject(projectId);
  useTitle(project.data?.name ?? projectId);
  const base = `/projects/${encodeURIComponent(projectId)}`;

  if (project.isPending) return <Loading />;
  if (project.error) return <ErrorBox error={project.error} />;
  if (!project.data) {
    return (
      <Empty>
        <p>プロジェクト「{projectId}」は見つかりません。</p>
        <Link href="/">概況へ戻る</Link>
      </Empty>
    );
  }

  return (
    <div className="stack">
      <nav className="crumbs">
        <Link href="/">概況</Link>
        <span aria-hidden="true">/</span>
        <span>{project.data.name}</span>
      </nav>
      <div className="page-head">
        <h1>{project.data.name}</h1>
        <div className="tabs" role="tablist">
          <Link
            href={base}
            className={tab === "issues" ? "tab active" : "tab"}
            role="tab"
            aria-selected={tab === "issues"}
          >
            Issue
          </Link>
          <Link
            href={`${base}/settings`}
            className={tab === "settings" ? "tab active" : "tab"}
            role="tab"
            aria-selected={tab === "settings"}
          >
            設定
          </Link>
        </div>
      </div>
      {tab === "issues" ? (
        <IssueList project={project.data} />
      ) : (
        <Settings project={project.data} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------- issue 一覧

const PERIODS: Record<string, number | undefined> = {
  "24h": 86_400_000,
  "7d": 7 * 86_400_000,
  "30d": 30 * 86_400_000,
  all: undefined,
};

function IssueList({ project }: { project: Project }) {
  const { search } = useLocation();
  const status = search.get("status") ?? "unresolved";
  const environment = search.get("environment") ?? "";
  const release = search.get("release") ?? "";
  const period = search.get("period") ?? "all";

  const facets = useQuery({
    queryKey: ["facets", project.id],
    queryFn: () =>
      api<{ environments: string[]; releases: string[] }>(`/projects/${project.id}/facets`),
  });

  const issues = useInfiniteQuery({
    queryKey: ["issues", project.id, status, environment, release, period],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => {
      const span = PERIODS[period];
      return api<Page<Issue>>(
        `/projects/${encodeURIComponent(project.id)}/issues${query({
          status: status === "all" ? undefined : status,
          environment,
          release,
          from: span ? Date.now() - span : undefined,
          cursor: pageParam,
        })}`,
      );
    },
    getNextPageParam: (last) => last.nextCursor,
  });

  const items = issues.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <Section
      title="Issue"
      actions={
        <div className="filters">
          <select
            aria-label="状態"
            value={status}
            onChange={(e) => setSearch({ status: e.target.value })}
          >
            <option value="unresolved">未解決</option>
            <option value="resolved">解決済み</option>
            <option value="ignored">無視</option>
            <option value="all">すべて</option>
          </select>
          <select
            aria-label="環境"
            value={environment}
            onChange={(e) => setSearch({ environment: e.target.value || undefined })}
          >
            <option value="">すべての環境</option>
            {facets.data?.environments.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
          <select
            aria-label="リリース"
            value={release}
            onChange={(e) => setSearch({ release: e.target.value || undefined })}
          >
            <option value="">すべてのリリース</option>
            {facets.data?.releases.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
          <select
            aria-label="期間"
            value={period}
            onChange={(e) => setSearch({ period: e.target.value })}
          >
            <option value="24h">24時間</option>
            <option value="7d">7日</option>
            <option value="30d">30日</option>
            <option value="all">全期間</option>
          </select>
        </div>
      }
    >
      {issues.isPending ? (
        <Loading />
      ) : issues.error ? (
        <ErrorBox error={issues.error} />
      ) : items.length === 0 ? (
        <Empty>
          <p>該当する issue はありません。</p>
          {project.allowedOrigins.length === 0 && status === "unresolved" && (
            <p className="muted">
              まだイベントが届いていない場合は、
              <Link href={`/projects/${project.id}/settings`}>設定</Link>
              の導入ガイドを確認してください。
            </p>
          )}
        </Empty>
      ) : (
        <>
          <ul className="issue-list">
            {items.map((i) => (
              <li key={i.id}>
                <Link href={`/issues/${i.id}`} className="issue-row">
                  <div className="issue-main">
                    <div className="issue-title">
                      <span className="strong">{i.type}</span>
                      <span className="issue-message">{i.message}</span>
                    </div>
                    <div className="muted small">
                      {i.culprit && <span className="mono">{i.culprit}</span>}
                      {i.culprit && " · "}
                      初回 {relativeTime(i.firstSeen)}
                    </div>
                  </div>
                  <div className="issue-side">
                    {status === "all" && <StatusBadge status={i.status} />}
                    <span className="num strong">{count(i.eventCount)}</span>
                    <span className="muted small">{relativeTime(i.lastSeen)}</span>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
          {issues.hasNextPage && (
            <div className="more">
              <button
                type="button"
                className="btn"
                onClick={() => issues.fetchNextPage()}
                disabled={issues.isFetchingNextPage}
              >
                さらに読み込む
              </button>
            </div>
          )}
        </>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------- 設定

function Settings({ project }: { project: Project }) {
  const qc = useQueryClient();
  const [name, setName] = useState(project.name);
  const [origins, setOrigins] = useState(project.allowedOrigins.join("\n"));
  const [retentionDays, setRetentionDays] = useState(project.retentionDays);
  const [dailyEventLimit, setDailyEventLimit] = useState(project.dailyEventLimit);
  const [confirmDelete, setConfirmDelete] = useState("");

  const refresh = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: ["projects"] }),
      qc.invalidateQueries({ queryKey: ["overview"] }),
    ]);

  const save = useMutation({
    mutationFn: (body: object) =>
      api<Project>(`/projects/${encodeURIComponent(project.id)}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    onSuccess: (p) => {
      setOrigins(p.allowedOrigins.join("\n"));
      return refresh();
    },
  });

  const remove = useMutation({
    mutationFn: () =>
      api<void>(`/projects/${encodeURIComponent(project.id)}`, { method: "DELETE" }),
    onSuccess: async () => {
      await refresh();
      navigate("/");
    },
  });

  const submit = (e: SubmitEvent) => {
    e.preventDefault();
    save.mutate({
      name,
      allowedOrigins: origins
        .split(/\s+/)
        .map((s) => s.trim())
        .filter(Boolean),
      retentionDays,
      dailyEventLimit,
    });
  };

  const snippet = `import { init } from "@errorcloud/browser";

init({
  key: "${project.publicKey}",
  endpoint: "/_e",           // 同一ドメインのパス
  release: "2026.11.17-1",   // ソースマップのリリース名と合わせる
  environment: "production",
});`;

  return (
    <>
      <Section title="導入ガイド">
        <ol className="guide">
          <li>
            トラッカーの <code>wrangler.jsonc</code> の <code>routes</code> に、サイトのドメインの{" "}
            <code>{"<ドメイン>/_e/*"}</code> を1行足してデプロイする。
          </li>
          <li>サイトに SDK を入れて、起動時に次のコードを実行する。</li>
        </ol>
        <pre className="code">{snippet}</pre>
        <p className="muted small">
          別の Cloudflare アカウントのサイトでは、<code>endpoint</code> にトラッカーのドメインの{" "}
          <code>https://…/_e</code> を指定する。
        </p>
      </Section>

      <Section title="公開キー">
        <div className="key-row">
          <code className="mono">{project.publicKey}</code>
          <button
            type="button"
            className="btn"
            disabled={save.isPending}
            onClick={() => {
              if (
                confirm(
                  "公開キーを再発行します。古いキーを使っているサイトからは受け付けなくなります。",
                )
              ) {
                save.mutate({ rotateKey: true });
              }
            }}
          >
            再発行
          </button>
        </div>
        <p className="muted small">
          ブラウザに露出する前提のキーで、イベントの送信しかできません。悪用されたら再発行してください。
        </p>
      </Section>

      <Section title="プロジェクト設定">
        <form className="form" onSubmit={submit}>
          <label>
            <span>名前</span>
            <input required value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label>
            <span>許可する Origin（1行に1つ）</span>
            <textarea rows={3} value={origins} onChange={(e) => setOrigins(e.target.value)} />
          </label>
          {origins.trim() === "" && (
            <p className="warn-box">
              許可する Origin が空なので、どのサイトからのイベントも受け付けます。サイトの Origin
              を登録してください。
            </p>
          )}
          <div className="form-row">
            <label>
              <span>保持期間（日）</span>
              <input
                type="number"
                min={1}
                max={365}
                value={retentionDays}
                onChange={(e) => setRetentionDays(Number(e.target.value))}
              />
            </label>
            <label>
              <span>1日の取り込み上限（件）</span>
              <input
                type="number"
                min={1}
                value={dailyEventLimit}
                onChange={(e) => setDailyEventLimit(Number(e.target.value))}
              />
            </label>
          </div>
          <ErrorBox error={save.error} />
          <div className="form-actions">
            <button type="submit" className="btn primary" disabled={save.isPending}>
              保存
            </button>
            {save.isSuccess && <span className="muted small">保存しました</span>}
          </div>
        </form>
      </Section>

      <Section title="プロジェクトを削除">
        <p className="muted small">
          issue、イベント、ソースマップをすべて削除します。元に戻せません。確認のため ID「
          {project.id}」を入力してください。
        </p>
        <div className="key-row">
          <input
            aria-label="削除するプロジェクトの ID"
            value={confirmDelete}
            onChange={(e) => setConfirmDelete(e.target.value)}
          />
          <button
            type="button"
            className="btn danger"
            disabled={confirmDelete !== project.id || remove.isPending}
            onClick={() => remove.mutate()}
          >
            削除
          </button>
        </div>
        <ErrorBox error={remove.error} />
      </Section>
    </>
  );
}
