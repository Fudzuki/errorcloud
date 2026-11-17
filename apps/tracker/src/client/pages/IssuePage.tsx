import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type {
  EventSummary,
  Issue,
  IssueStats,
  IssueStatus,
  Page,
  StoredEvent,
} from "../../shared/types";
import { api, query } from "../api";
import { BarChart } from "../components/BarChart";
import { Empty, ErrorBox, Loading, Section, StatusBadge } from "../components/ui";
import { count, dateTime, relativeTime, STATUS_LABEL } from "../format";
import { useProject } from "../hooks";
import { Link, setSearch, useLocation, useTitle } from "../router";

// エラー文や URL は外部から届く信頼できない文字列。React のテキストとしてだけ描画し、
// HTML として挿入したりリンクにしたりしない（技術定義書 6章）

export function IssuePage({ issueId }: { issueId: string }) {
  const qc = useQueryClient();
  const issue = useQuery({
    queryKey: ["issue", issueId],
    queryFn: () => api<Issue>(`/issues/${issueId}`),
  });
  const project = useProject(issue.data?.projectId);
  useTitle(issue.data ? `${issue.data.type}: ${issue.data.message}` : "Issue");

  const setStatus = useMutation({
    mutationFn: (status: IssueStatus) =>
      api<Issue>(`/issues/${issueId}`, { method: "PATCH", body: JSON.stringify({ status }) }),
    onSuccess: (updated) => {
      qc.setQueryData(["issue", issueId], updated);
      return qc.invalidateQueries({ queryKey: ["issues", updated.projectId] });
    },
  });

  if (issue.isPending) return <Loading />;
  if (issue.error) return <ErrorBox error={issue.error} />;
  const i = issue.data;
  const projectHref = `/projects/${encodeURIComponent(i.projectId)}`;

  return (
    <div className="stack">
      <nav className="crumbs">
        <Link href="/">概況</Link>
        <span aria-hidden="true">/</span>
        <Link href={projectHref}>{project.data?.name ?? i.projectId}</Link>
        <span aria-hidden="true">/</span>
        <span>Issue</span>
      </nav>

      <header className="issue-head">
        <div>
          <h1 className="issue-heading">
            <span>{i.type}</span>
            <StatusBadge status={i.status} />
          </h1>
          <p className="issue-message-full">{i.message}</p>
          {i.culprit && <p className="mono muted small">{i.culprit}</p>}
        </div>
        <div className="status-actions">
          {(["unresolved", "resolved", "ignored"] as const)
            .filter((s) => s !== i.status)
            .map((s) => (
              <button
                key={s}
                type="button"
                className={s === "resolved" ? "btn primary" : "btn"}
                disabled={setStatus.isPending}
                onClick={() => setStatus.mutate(s)}
              >
                {s === "unresolved" ? "未解決に戻す" : `${STATUS_LABEL[s]}にする`}
              </button>
            ))}
        </div>
      </header>
      <ErrorBox error={setStatus.error} />

      <dl className="facts">
        <div>
          <dt>発生回数</dt>
          <dd>{count(i.eventCount)}</dd>
        </div>
        <div>
          <dt>初回</dt>
          <dd title={dateTime(i.firstSeen)}>{relativeTime(i.firstSeen)}</dd>
        </div>
        <div>
          <dt>最終</dt>
          <dd title={dateTime(i.lastSeen)}>{relativeTime(i.lastSeen)}</dd>
        </div>
      </dl>

      <Stats issueId={issueId} />
      <Events issueId={issueId} />
    </div>
  );
}

function Stats({ issueId }: { issueId: string }) {
  const [range, setRange] = useState("24h");
  const stats = useQuery({
    queryKey: ["stats", issueId, range],
    queryFn: () => api<IssueStats>(`/issues/${issueId}/stats${query({ range })}`),
  });
  return (
    <Section
      title="発生回数"
      actions={
        <select aria-label="期間" value={range} onChange={(e) => setRange(e.target.value)}>
          <option value="24h">24時間</option>
          <option value="7d">7日</option>
          <option value="30d">30日</option>
          <option value="90d">90日</option>
        </select>
      }
    >
      {stats.isPending ? (
        <Loading />
      ) : stats.error ? (
        <ErrorBox error={stats.error} />
      ) : (
        <BarChart points={stats.data.points} interval={stats.data.interval} />
      )}
    </Section>
  );
}

function Events({ issueId }: { issueId: string }) {
  const { search } = useLocation();
  const events = useInfiniteQuery({
    queryKey: ["events", issueId],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      api<Page<EventSummary>>(`/issues/${issueId}/events${query({ cursor: pageParam })}`),
    getNextPageParam: (last) => last.nextCursor,
  });
  const items = events.data?.pages.flatMap((p) => p.items) ?? [];
  const selected = search.get("event") ?? items[0]?.id;

  return (
    <Section title="保存済みのイベント">
      <p className="muted small">
        本体を保存するのは、issue
        ごとに1時間あたり最初の10件までです。それ以降は件数だけ数えています。
      </p>
      {events.isPending ? (
        <Loading />
      ) : events.error ? (
        <ErrorBox error={events.error} />
      ) : items.length === 0 ? (
        <Empty>保存済みのイベントはありません（保持期間を過ぎた可能性があります）。</Empty>
      ) : (
        <div className="events-layout">
          <ul className="event-list">
            {items.map((e) => (
              <li key={e.id}>
                <button
                  type="button"
                  className={e.id === selected ? "event-item active" : "event-item"}
                  onClick={() => setSearch({ event: e.id })}
                >
                  <span>{dateTime(e.ts)}</span>
                  <span className="muted small">
                    {[e.environment, e.release].filter(Boolean).join(" · ") || "—"}
                  </span>
                </button>
              </li>
            ))}
            {events.hasNextPage && (
              <li>
                <button
                  type="button"
                  className="btn block"
                  onClick={() => events.fetchNextPage()}
                  disabled={events.isFetchingNextPage}
                >
                  さらに読み込む
                </button>
              </li>
            )}
          </ul>
          {selected && <EventDetail eventId={selected} />}
        </div>
      )}
    </Section>
  );
}

function EventDetail({ eventId }: { eventId: string }) {
  const event = useQuery({
    queryKey: ["event", eventId],
    queryFn: () => api<StoredEvent>(`/events/${eventId}`),
    // 本体は変わらないので再取得しない
    staleTime: Number.POSITIVE_INFINITY,
    refetchInterval: false,
  });
  if (event.isPending) return <Loading />;
  if (event.error) return <ErrorBox error={event.error} />;
  const { event: e, frames, release, environment, userAgent, receivedAt } = event.data;

  return (
    <article className="event-detail">
      <dl className="kv">
        <dt>受信</dt>
        <dd>{dateTime(receivedAt)}</dd>
        <dt>種類</dt>
        <dd>{e.kind}</dd>
        {e.url && (
          <>
            <dt>URL</dt>
            <dd className="mono break">{e.url}</dd>
          </>
        )}
        {release && (
          <>
            <dt>リリース</dt>
            <dd className="mono">{release}</dd>
          </>
        )}
        {environment && (
          <>
            <dt>環境</dt>
            <dd>{environment}</dd>
          </>
        )}
        {userAgent && (
          <>
            <dt>User-Agent</dt>
            <dd className="small break">{userAgent}</dd>
          </>
        )}
        {e.request && (
          <>
            <dt>リクエスト</dt>
            <dd className="mono break">
              {[e.request.method, e.request.url, e.request.status]
                .filter((v) => v !== undefined)
                .join(" ")}
              {e.request.rayId && <span className="muted"> (Ray ID {e.request.rayId})</span>}
            </dd>
          </>
        )}
      </dl>

      <h3>スタックトレース</h3>
      {frames.length === 0 ? (
        <p className="muted small">スタックトレースはありません。</p>
      ) : (
        <ol className="frames">
          {frames.map((f, idx) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: フレームは並び順そのものが識別子
            <li key={idx} className={f.inApp ? "frame in-app" : "frame"}>
              <span className="frame-fn">{f.function ?? "<anonymous>"}</span>
              <span className="mono small break">
                {f.file}
                {f.line !== undefined && `:${f.line}:${f.column ?? 0}`}
              </span>
            </li>
          ))}
        </ol>
      )}
      <p className="muted small">
        圧縮後の位置を表示しています（ソースマップでの復元にはまだ対応していません）。
      </p>
      {e.stack && (
        <details>
          <summary>元のスタック文字列</summary>
          <pre className="code">{e.stack}</pre>
        </details>
      )}
      {e.extra && (
        <details>
          <summary>追加情報</summary>
          <pre className="code">{JSON.stringify(e.extra, null, 2)}</pre>
        </details>
      )}
    </article>
  );
}
