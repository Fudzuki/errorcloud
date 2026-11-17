// sourcemaps upload の本体（技術定義書 7章「アップロード」、段階2）。
// --dir 以下の JavaScript とソースマップを対応づけ、配信時のパスをキーにしてトラッカーへ送る。
import { readdir, readFile, rm } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

const JS_EXT = /\.(?:m?js|cjs)$/;

export type Upload = {
  /** ローカルのソースマップのパス */
  file: string;
  /** 配信時のパス + ".map"（トラッカー側のキー）。先頭の "/" は付けない */
  key: string;
};

export type UploadOptions = {
  url: string;
  project: string;
  release: string;
  dir: string;
  /** 配信時のパスの接頭辞。dist を /static/ で配信しているなら "static" */
  urlPrefix?: string;
  /** アップロードに成功した .map を削除する */
  deleteAfter?: boolean;
  dryRun?: boolean;
  /** Cloudflare Access のサービストークン */
  accessClientId?: string;
  accessClientSecret?: string;
  concurrency?: number;
  fetch?: typeof fetch;
  log?: (line: string) => void;
};

export type UploadResult = { uploaded: Upload[]; failed: { upload: Upload; error: string }[] };

async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries.filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name));
}

const toPosix = (p: string) => p.split(sep).join("/");

function joinKey(prefix: string | undefined, path: string): string {
  const clean = (prefix ?? "").replace(/^\/+|\/+$/g, "");
  return clean ? `${clean}/${path}` : path;
}

/** ファイル末尾の sourceMappingURL を読む。data: URL（インライン）は対象外 */
export function sourceMappingUrl(code: string): string | undefined {
  const re = /\/[/*][#@]\s*sourceMappingURL=([^\s*]+)/g;
  let last: string | undefined;
  for (let m = re.exec(code); m; m = re.exec(code)) last = m[1];
  if (!last || last.startsWith("data:") || /^[a-z]+:\/\//i.test(last)) return undefined;
  return last.split(/[?#]/)[0];
}

/**
 * アップロードするものを決める。JavaScript ごとに、sourceMappingURL が指す .map か、
 * なければ隣の <ファイル名>.map を対応させ、キーは JavaScript の配信時のパス + ".map" にする。
 * どの JavaScript にも対応しない .map は、そのパスのまま送る。
 */
export async function planUploads(dir: string, urlPrefix?: string): Promise<Upload[]> {
  const root = resolve(dir);
  const files = await walk(root);
  const maps = new Set(files.filter((f) => f.endsWith(".map")));
  const used = new Set<string>();
  const uploads: Upload[] = [];

  for (const js of files.filter((f) => JS_EXT.test(f)).sort()) {
    let map: string | undefined;
    const ref = sourceMappingUrl(await readFile(js, "utf8"));
    if (ref) {
      const candidate = resolve(dirname(js), decodeURIComponent(ref));
      if (maps.has(candidate)) map = candidate;
    }
    if (!map && maps.has(`${js}.map`)) map = `${js}.map`;
    if (!map || used.has(map)) continue;
    used.add(map);
    uploads.push({ file: map, key: joinKey(urlPrefix, `${toPosix(relative(root, js))}.map`) });
  }
  for (const map of [...maps].sort()) {
    if (used.has(map)) continue;
    uploads.push({ file: map, key: joinKey(urlPrefix, toPosix(relative(root, map))) });
  }
  return uploads;
}

export function uploadUrl(base: string, project: string, release: string, key: string): string {
  const path = key.split("/").map(encodeURIComponent).join("/");
  return `${base.replace(/\/+$/, "")}/api/sourcemaps/${encodeURIComponent(project)}/${encodeURIComponent(release)}/${path}`;
}

export async function uploadSourcemaps(opts: UploadOptions): Promise<UploadResult> {
  const log = opts.log ?? console.log;
  const doFetch = opts.fetch ?? fetch;
  const uploads = await planUploads(opts.dir, opts.urlPrefix);
  const result: UploadResult = { uploaded: [], failed: [] };
  if (uploads.length === 0) {
    log(`${opts.dir} にソースマップ（.map）が見つかりません`);
    return result;
  }

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.accessClientId && opts.accessClientSecret) {
    headers["CF-Access-Client-Id"] = opts.accessClientId;
    headers["CF-Access-Client-Secret"] = opts.accessClientSecret;
  }

  const queue = [...uploads];
  const worker = async () => {
    for (let u = queue.shift(); u; u = queue.shift()) {
      if (opts.dryRun) {
        log(`[dry-run] ${toPosix(relative(process.cwd(), u.file))} → ${u.key}`);
        result.uploaded.push(u);
        continue;
      }
      try {
        const res = await doFetch(uploadUrl(opts.url, opts.project, opts.release, u.key), {
          method: "PUT",
          headers,
          body: await readFile(u.file),
          // Access のログイン画面へのリダイレクトを成功と取り違えない
          redirect: "manual",
        });
        if (res.status !== 201) {
          let message = `HTTP ${res.status}`;
          try {
            const body = (await res.json()) as { error?: string };
            if (body.error) message += ` ${body.error}`;
          } catch {
            if (res.status >= 300 && res.status < 400) {
              message += "（Cloudflare Access のサービストークンを確認してください）";
            }
          }
          throw new Error(message);
        }
        log(`✓ ${u.key}`);
        result.uploaded.push(u);
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        log(`✗ ${u.key}: ${error}`);
        result.failed.push({ upload: u, error });
      }
    }
  };
  await Promise.all(Array.from({ length: opts.concurrency ?? 4 }, worker));

  if (opts.deleteAfter && !opts.dryRun) {
    // 失敗したものは残す（やり直せるように）
    for (const u of result.uploaded) await rm(u.file, { force: true });
    log(`アップロードした .map を ${result.uploaded.length} 件削除しました`);
  }
  return result;
}
