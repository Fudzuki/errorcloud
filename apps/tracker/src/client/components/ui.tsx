import type { ReactNode } from "react";
import type { IssueStatus } from "../../shared/types";
import { STATUS_LABEL } from "../format";

export function ErrorBox({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <p className="error-box" role="alert">
      {error instanceof Error ? error.message : String(error)}
    </p>
  );
}

export function Loading() {
  return <p className="muted">読み込み中…</p>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function StatusBadge({ status }: { status: IssueStatus }) {
  return <span className={`badge badge-${status}`}>{STATUS_LABEL[status]}</span>;
}

export function Section({
  title,
  actions,
  children,
}: {
  title: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="card">
      <header className="card-head">
        <h2>{title}</h2>
        {actions}
      </header>
      {children}
    </section>
  );
}
