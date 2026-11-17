// ソースマップのアップロードと取得（技術定義書 7章、段階2）。
// /api/* の内側に置くので Access の検証を通ったリクエストだけが届く。CLI は Access の
// サービストークン（CF-Access-Client-Id / CF-Access-Client-Secret）を付けて送る。
// Worker 側ではソースマップを解析しない（CPU 時間を使わない）。復元はダッシュボードのブラウザ内で行う。
import { Hono } from "hono";
import type { AppEnv } from "../env";

export const MAX_SOURCEMAP_BYTES = 32 * 1024 * 1024;
const MAX_PATH_LENGTH = 512;
const MAX_RELEASE_LENGTH = 200;

export const sourcemaps = new Hono<{ Bindings: AppEnv }>();

export function sourcemapR2Key(projectId: string, release: string, path: string): string {
  return `sourcemaps/${projectId}/${release}/${path}`;
}

type Target = { projectId: string; release: string; path: string };

/**
 * /api/sourcemaps/:project/:release/<配信時のパス>.map を分解して検証する。
 * リリース名は1つのパス区間として URL エンコードして送る（"/" を含められる）。
 */
export function parseTarget(pathname: string): Target | string {
  const rest = pathname.replace(/^\/api\/sourcemaps\//, "");
  let segments: string[];
  try {
    segments = rest.split("/").map((s) => decodeURIComponent(s));
  } catch {
    return "パスの URL エンコードが正しくありません";
  }
  const [projectId = "", release = "", ...file] = segments;
  if (!projectId) return "プロジェクトを指定してください";
  if (!release || release.length > MAX_RELEASE_LENGTH || hasControlChars(release)) {
    return `リリース名は1〜${MAX_RELEASE_LENGTH}文字で指定してください`;
  }
  if (file.length === 0) return "ファイルのパスを指定してください";
  if (file.some((s) => s === "" || s === "." || s === ".." || s.includes("\\"))) {
    return "ファイルのパスに空の区間、.、..、\\ は使えません";
  }
  const path = file.join("/");
  if (path.length > MAX_PATH_LENGTH || hasControlChars(path)) return "ファイルのパスが長すぎます";
  if (!path.endsWith(".map")) return "ファイル名は .map で終わる必要があります";
  return { projectId, release, path };
}

function hasControlChars(s: string): boolean {
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) < 0x20) return true;
  return false;
}

/** JSON として解析はしない（大きなファイルで CPU 時間を使うため）。先頭が { かだけ確かめる */
function looksLikeJson(bytes: Uint8Array): boolean {
  for (const b of bytes.subarray(0, 64)) {
    if (b === 0x20 || b === 0x0a || b === 0x0d || b === 0x09 || b === 0xef || b === 0xbb) continue;
    if (b === 0xbf) continue;
    return b === 0x7b;
  }
  return false;
}

sourcemaps.put("/*", async (c) => {
  const target = parseTarget(new URL(c.req.url).pathname);
  if (typeof target === "string") return c.json({ error: target }, 400);

  const declared = Number(c.req.header("Content-Length") ?? "0");
  if (declared > MAX_SOURCEMAP_BYTES) {
    return c.json({ error: `ソースマップは ${MAX_SOURCEMAP_BYTES / 1024 / 1024}MB までです` }, 413);
  }
  const project = await c.env.DB.prepare("SELECT id FROM projects WHERE id = ?")
    .bind(target.projectId)
    .first();
  if (!project) return c.json({ error: `プロジェクト「${target.projectId}」はありません` }, 404);

  const body = new Uint8Array(await c.req.arrayBuffer());
  if (body.byteLength > MAX_SOURCEMAP_BYTES) {
    return c.json({ error: `ソースマップは ${MAX_SOURCEMAP_BYTES / 1024 / 1024}MB までです` }, 413);
  }
  if (!looksLikeJson(body)) return c.json({ error: "ソースマップ（JSON）を送ってください" }, 400);

  const key = sourcemapR2Key(target.projectId, target.release, target.path);
  await c.env.BUCKET.put(key, body, { httpMetadata: { contentType: "application/json" } });
  await c.env.DB.prepare(
    "INSERT OR IGNORE INTO releases (project_id, release, created_at) VALUES (?, ?, ?)",
  )
    .bind(target.projectId, target.release, Date.now())
    .run();
  return c.json({ key, size: body.byteLength }, 201);
});

sourcemaps.get("/*", async (c) => {
  const target = parseTarget(new URL(c.req.url).pathname);
  if (typeof target === "string") return c.json({ error: target }, 400);
  const obj = await c.env.BUCKET.get(sourcemapR2Key(target.projectId, target.release, target.path));
  if (!obj) return c.json({ error: "ソースマップがありません" }, 404);
  // 元のソースコードを含むので、共有キャッシュには載せない
  return new Response(obj.body, {
    headers: { "Content-Type": "application/json", "Cache-Control": "private, max-age=300" },
  });
});
