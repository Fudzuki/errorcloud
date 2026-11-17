import { IssuePage } from "./pages/IssuePage";
import { OverviewPage } from "./pages/OverviewPage";
import { ProjectPage } from "./pages/ProjectPage";
import { TracePage } from "./pages/TracePage";
import { Link, useLocation } from "./router";

function route(pathname: string) {
  let m = /^\/projects\/([^/]+)(?:\/(settings))?\/?$/.exec(pathname);
  if (m?.[1]) {
    return <ProjectPage projectId={decodeURIComponent(m[1])} tab={m[2] ? "settings" : "issues"} />;
  }
  m = /^\/issues\/([^/]+)\/?$/.exec(pathname);
  if (m?.[1]) return <IssuePage issueId={decodeURIComponent(m[1])} />;
  m = /^\/traces\/([^/]+)\/?$/.exec(pathname);
  if (m?.[1]) return <TracePage traceId={decodeURIComponent(m[1])} />;
  if (pathname === "/" || pathname === "") return <OverviewPage />;
  return (
    <div className="empty">
      <p>ページが見つかりません。</p>
      <Link href="/">概況へ戻る</Link>
    </div>
  );
}

export function App() {
  const { pathname } = useLocation();
  return (
    <>
      <header className="topbar">
        <Link href="/" className="brand">
          <span className="brand-mark" aria-hidden="true" />
          errorcloud
        </Link>
      </header>
      <main className="main">{route(pathname)}</main>
    </>
  );
}
