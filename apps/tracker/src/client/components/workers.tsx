// Worker とプロジェクトの対応（段階3）
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type SubmitEvent, useState } from "react";
import type { Project, WorkerMapping } from "../../shared/types";
import { api } from "../api";
import { count, relativeTime } from "../format";
import { ErrorBox, Section } from "./ui";

function useAssign() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ name, projectId }: { name: string; projectId: string | null }) =>
      api<WorkerMapping>(`/workers/${encodeURIComponent(name)}`, {
        method: "PUT",
        body: JSON.stringify({ projectId }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["workers"] }),
  });
}

/** 概況に出す。未割り当ての Worker がなければ何も表示しない */
export function UnassignedWorkers({ projects }: { projects: { id: string; name: string }[] }) {
  const workers = useQuery({
    queryKey: ["workers", "unassigned"],
    queryFn: () => api<WorkerMapping[]>("/workers/unassigned"),
  });
  const assign = useAssign();
  const [choice, setChoice] = useState<Record<string, string>>({});
  if (!workers.data || workers.data.length === 0) return null;

  return (
    <Section title="未割り当ての Worker">
      <p className="muted small">
        {
          "OTLP でエラーが届いたものの、プロジェクトに割り当てられていない Worker です。割り当てるまでのエラーは件数だけ数えて捨てています。"
        }
      </p>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Worker</th>
              <th className="num">エラー</th>
              <th>最終受信</th>
              <th>割り当て先</th>
            </tr>
          </thead>
          <tbody>
            {workers.data.map((w) => (
              <tr key={w.name}>
                <td className="mono">{w.name}</td>
                <td className="num">{count(w.eventCount)}</td>
                <td className="muted">{relativeTime(w.lastSeen ?? w.firstSeen)}</td>
                <td>
                  <div className="key-row">
                    <select
                      aria-label={`${w.name} の割り当て先`}
                      value={choice[w.name] ?? ""}
                      onChange={(e) => setChoice({ ...choice, [w.name]: e.target.value })}
                    >
                      <option value="">プロジェクトを選ぶ</option>
                      {projects.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className="btn"
                      disabled={!choice[w.name] || assign.isPending}
                      onClick={() =>
                        assign.mutate({ name: w.name, projectId: choice[w.name] ?? null })
                      }
                    >
                      割り当て
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ErrorBox error={assign.error} />
    </Section>
  );
}

/** プロジェクト設定に出す。割り当て済みの Worker の一覧と追加、解除 */
export function ProjectWorkers({ project }: { project: Project }) {
  const workers = useQuery({
    queryKey: ["workers", "project", project.id],
    queryFn: () => api<WorkerMapping[]>(`/workers?project=${encodeURIComponent(project.id)}`),
  });
  const assign = useAssign();
  const [name, setName] = useState("");

  const submit = (e: SubmitEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    assign.mutate({ name: trimmed, projectId: project.id }, { onSuccess: () => setName("") });
  };

  return (
    <Section title="Worker">
      <p className="muted small">
        ここに割り当てた Worker から OTLP で届いたエラーとトレースを、このプロジェクトの issue
        にします。Worker 名は wrangler 設定の <code>name</code> です。
      </p>
      {workers.data && workers.data.length > 0 && (
        <ul className="worker-list">
          {workers.data.map((w) => (
            <li key={w.name} className="worker-row">
              <span className="mono">{w.name}</span>
              <span className="muted small worker-when">
                {w.lastSeen ? `最終受信 ${relativeTime(w.lastSeen)}` : "まだ届いていません"}
              </span>
              <button
                type="button"
                className="btn"
                disabled={assign.isPending}
                onClick={() => assign.mutate({ name: w.name, projectId: null })}
              >
                解除
              </button>
            </li>
          ))}
        </ul>
      )}
      <form className="key-row" onSubmit={submit}>
        <input
          aria-label="追加する Worker 名"
          placeholder="my-api-worker"
          value={name}
          pattern="[A-Za-z0-9][A-Za-z0-9_.\\-]*"
          onChange={(e) => setName(e.target.value)}
        />
        <button type="submit" className="btn" disabled={!name.trim() || assign.isPending}>
          追加
        </button>
      </form>
      <ErrorBox error={assign.error} />
    </Section>
  );
}
