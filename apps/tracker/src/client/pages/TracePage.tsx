// トレースの表示（技術定義書 5章 GET /api/traces/:id、段階4）。スパンを親子順に並べ、時間軸に置く
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import type { SpanRecord, StoredTrace } from "../../shared/types";
import { api } from "../api";
import { ErrorBox, Loading, Section } from "../components/ui";
import { dateTime, duration } from "../format";
import { useProject } from "../hooks";
import { Link, useTitle } from "../router";

type Row = { span: SpanRecord; depth: number };

/** 親子関係をたどって深さ優先に並べる。親が届いていないスパンは最上位に置く */
export function orderSpans(spans: SpanRecord[]): Row[] {
  const ids = new Set(spans.map((s) => s.spanId));
  const children = new Map<string, SpanRecord[]>();
  const roots: SpanRecord[] = [];
  for (const s of [...spans].sort((a, b) => a.start - b.start)) {
    if (s.parentSpanId && ids.has(s.parentSpanId)) {
      const list = children.get(s.parentSpanId) ?? [];
      list.push(s);
      children.set(s.parentSpanId, list);
    } else roots.push(s);
  }
  const rows: Row[] = [];
  const visit = (s: SpanRecord, depth: number) => {
    rows.push({ span: s, depth });
    for (const c of children.get(s.spanId) ?? []) visit(c, depth + 1);
  };
  for (const r of roots) visit(r, 0);
  return rows;
}

export function TracePage({ traceId }: { traceId: string }) {
  const trace = useQuery({
    queryKey: ["trace", traceId],
    queryFn: () => api<StoredTrace>(`/traces/${traceId}`),
    staleTime: 30_000,
  });
  const project = useProject(trace.data?.projectId);
  const [selected, setSelected] = useState<string | null>(null);
  useTitle(trace.data ? `トレース ${trace.data.worker}` : "トレース");

  if (trace.isPending) return <Loading />;
  if (trace.error) return <ErrorBox error={trace.error} />;
  const t = trace.data;
  const rows = orderSpans(t.spans);
  const total = Math.max(1, t.durationMs);
  const current =
    rows.find((r) => r.span.spanId === selected)?.span ??
    rows.find((r) => r.span.status === "error")?.span;

  return (
    <div className="stack">
      <nav className="crumbs">
        <Link href="/">概況</Link>
        <span aria-hidden="true">/</span>
        <Link href={`/projects/${encodeURIComponent(t.projectId)}`}>
          {project.data?.name ?? t.projectId}
        </Link>
        <span aria-hidden="true">/</span>
        <span>トレース</span>
      </nav>
      <header>
        <h1>{t.worker}</h1>
        <p className="muted small mono break">{t.traceId}</p>
      </header>
      <dl className="facts">
        <div>
          <dt>開始</dt>
          <dd className="small">{dateTime(t.start)}</dd>
        </div>
        <div>
          <dt>所要時間</dt>
          <dd>{duration(t.durationMs)}</dd>
        </div>
        <div>
          <dt>スパン</dt>
          <dd>{t.spans.length}</dd>
        </div>
        {t.rayId && (
          <div>
            <dt>Ray ID</dt>
            <dd className="mono small">{t.rayId}</dd>
          </div>
        )}
      </dl>

      <Section title="スパン">
        <ol className="waterfall">
          {rows.map(({ span, depth }) => {
            const left = ((span.start - t.start) / total) * 100;
            const width = Math.max(0.5, ((span.end - span.start) / total) * 100);
            return (
              <li key={span.spanId}>
                <button
                  type="button"
                  className={`span-row${span.spanId === current?.spanId ? " active" : ""}`}
                  onClick={() => setSelected(span.spanId)}
                >
                  <span className="span-name" style={{ paddingLeft: `${depth * 14}px` }}>
                    {span.name || "(名前なし)"}
                  </span>
                  <span className="span-track">
                    <span
                      className={`span-bar${span.status === "error" ? " error" : ""}`}
                      style={{
                        left: `${Math.min(left, 99.5)}%`,
                        width: `${Math.min(width, 100 - left)}%`,
                      }}
                    />
                  </span>
                  <span className="span-dur muted small">{duration(span.end - span.start)}</span>
                </button>
              </li>
            );
          })}
        </ol>
      </Section>

      {current && (
        <Section title={current.name || "スパン"}>
          <dl className="kv">
            <dt>状態</dt>
            <dd>
              {current.status === "error" ? "エラー" : current.status === "ok" ? "成功" : "未設定"}
              {current.statusMessage && <span className="muted"> {current.statusMessage}</span>}
            </dd>
            {Object.entries(current.attributes).map(([k, v]) => (
              <Attr key={k} name={k} value={String(v)} />
            ))}
          </dl>
          {current.events?.map((ev, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: スパンのイベントは並び順そのものが識別子
            <details key={i} open={ev.name === "exception"}>
              <summary>
                {ev.name} <span className="muted small">{dateTime(ev.ts)}</span>
              </summary>
              <pre className="code">
                {typeof ev.attributes["exception.stacktrace"] === "string"
                  ? ev.attributes["exception.stacktrace"]
                  : JSON.stringify(ev.attributes, null, 2)}
              </pre>
            </details>
          ))}
        </Section>
      )}
    </div>
  );
}

function Attr({ name, value }: { name: string; value: string }) {
  return (
    <>
      <dt className="mono small">{name}</dt>
      <dd className="mono small break">{value}</dd>
    </>
  );
}
