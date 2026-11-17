// ソースマップによるスタックの復元（技術定義書 7章「復元」、段階2）。
// Worker 側では解析せず、ダッシュボードを開いているブラウザの中で行う。
import { originalPositionFor, sourceContentFor, TraceMap } from "@jridgewell/trace-mapping";
import type { StackFrame } from "../shared/types";
import { HttpError } from "./api";

export type ResolvedFrame = {
  source: string;
  line: number;
  column: number;
  name: string | null;
  /** 前後の行。[行番号, 内容] */
  context: [number, string][];
};

const CONTEXT_LINES = 3;

/**
 * フレームのファイルから、ソースマップを引くときのパス（配信時のパス + ".map"）を作る。
 * https://example.com/assets/app.js → assets/app.js.map。クエリ文字列は除く。
 */
export function mapPathOf(file: string): string | null {
  let path: string;
  try {
    const url = new URL(file);
    if (url.protocol !== "http:" && url.protocol !== "https:" && url.protocol !== "file:") {
      return null;
    }
    path = url.pathname;
  } catch {
    // Worker のスタックは "index.js" のような相対パス
    path = file.split(/[?#]/)[0] ?? file;
  }
  path = path.replace(/^\/+/, "");
  return path ? `${path}.map` : null;
}

export async function fetchSourceMap(
  projectId: string,
  release: string,
  mapPath: string,
): Promise<TraceMap | null> {
  const path = mapPath.split("/").map(encodeURIComponent).join("/");
  const res = await fetch(
    `/api/sourcemaps/${encodeURIComponent(projectId)}/${encodeURIComponent(release)}/${path}`,
  );
  if (res.status === 404) return null;
  if (!res.ok)
    throw new HttpError(res.status, `ソースマップを取得できません（HTTP ${res.status}）`);
  return new TraceMap(await res.text());
}

/** "webpack://app/./src/x.ts" や "../../src/x.ts" を読みやすくする */
export function prettySource(source: string): string {
  return source
    .replace(/^webpack:\/\/[^/]*\//, "")
    .replace(/^(?:\.\.?\/)+/, "")
    .replace(/^\/+/, "");
}

export function resolveFrame(map: TraceMap, frame: StackFrame): ResolvedFrame | null {
  if (frame.line === undefined) return null;
  // スタックの列は1始まり、trace-mapping の列は0始まり
  const pos = originalPositionFor(map, {
    line: frame.line,
    column: Math.max(0, (frame.column ?? 1) - 1),
  });
  if (pos.source === null || pos.line === null) return null;

  const context: [number, string][] = [];
  const content = sourceContentFor(map, pos.source);
  if (content) {
    const lines = content.split("\n");
    const from = Math.max(1, pos.line - CONTEXT_LINES);
    const to = Math.min(lines.length, pos.line + CONTEXT_LINES);
    for (let n = from; n <= to; n++) context.push([n, lines[n - 1] ?? ""]);
  }
  return {
    source: prettySource(pos.source),
    line: pos.line,
    column: (pos.column ?? 0) + 1,
    name: pos.name,
    context,
  };
}
