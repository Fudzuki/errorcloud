// 小さな履歴ベースのルーター。ページは数枚しかないのでライブラリは使わない
import { type AnchorHTMLAttributes, type MouseEvent, useEffect, useSyncExternalStore } from "react";

const listeners = new Set<() => void>();

function subscribe(fn: () => void) {
  listeners.add(fn);
  window.addEventListener("popstate", fn);
  return () => {
    listeners.delete(fn);
    window.removeEventListener("popstate", fn);
  };
}

export function navigate(to: string, replace = false): void {
  if (replace) history.replaceState(null, "", to);
  else history.pushState(null, "", to);
  for (const fn of listeners) fn();
  if (!replace) window.scrollTo(0, 0);
}

export function useLocation(): { pathname: string; search: URLSearchParams } {
  const href = useSyncExternalStore(subscribe, () => location.pathname + location.search);
  const url = new URL(href, location.origin);
  return { pathname: url.pathname, search: url.searchParams };
}

/** 現在の URL のクエリ文字列を書き換える（履歴は増やさない） */
export function setSearch(params: Record<string, string | undefined>): void {
  const s = new URLSearchParams(location.search);
  for (const [k, v] of Object.entries(params)) {
    if (v) s.set(k, v);
    else s.delete(k);
  }
  const qs = s.toString();
  navigate(`${location.pathname}${qs ? `?${qs}` : ""}`, true);
}

export function Link({
  href,
  onClick,
  ...rest
}: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) {
  const handle = (e: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(e);
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)
      return;
    e.preventDefault();
    navigate(href);
  };
  return <a href={href} onClick={handle} {...rest} />;
}

export function useTitle(title: string): void {
  useEffect(() => {
    document.title = title ? `${title} · errorcloud` : "errorcloud";
  }, [title]);
}
