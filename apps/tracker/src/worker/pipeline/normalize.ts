// イベントの正規化とフィンガープリント（技術定義書 3章）
import type { BrowserEvent, StackFrame } from "../../shared/types";

const MAX_MESSAGE_LENGTH = 2000;
const MAX_STACK_LENGTH = 16 * 1024;
const MAX_FRAMES = 50;

// ---------------------------------------------------------------- スタック

// Chrome / Edge: "    at fn (https://x/app.js:1:2)" または "    at https://x/app.js:1:2"
const CHROME_FRAME =
  /^\s*at (?:(.+?) \()?((?:[a-z][a-z0-9+.-]*:\/\/|\/)[^\s()]*?):(\d+):(\d+)\)?\s*$/i;
// Firefox / Safari: "fn@https://x/app.js:1:2"
const GECKO_FRAME = /^\s*(.*?)@((?:[a-z][a-z0-9+.-]*:\/\/|\/)[^\s@]*?):(\d+):(\d+)\s*$/i;

const EXTENSION_SCHEME = /^(?:chrome|moz|safari|safari-web|ms-browser)-extension:\/\//i;

export function parseStack(stack: string | undefined, pageUrl?: string): StackFrame[] {
  if (!stack) return [];
  let pageHost: string | undefined;
  try {
    pageHost = pageUrl ? new URL(pageUrl).host : undefined;
  } catch {
    pageHost = undefined;
  }

  const frames: StackFrame[] = [];
  for (const line of stack.split("\n")) {
    const m = CHROME_FRAME.exec(line) ?? GECKO_FRAME.exec(line);
    if (!m) continue;
    const [, fn, file = "", lineNo, col] = m;
    frames.push({
      function: fn?.trim() || undefined,
      file,
      line: Number(lineNo),
      column: Number(col),
      inApp: isInApp(file, pageHost),
    });
    if (frames.length >= MAX_FRAMES) break;
  }
  return frames;
}

function isInApp(file: string, pageHost: string | undefined): boolean {
  if (EXTENSION_SCHEME.test(file)) return false;
  if (file.startsWith("/")) return true;
  try {
    const url = new URL(file);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    // ページと同じホストから配信されたスクリプトをアプリ内とみなす
    return pageHost ? url.host === pageHost : true;
  } catch {
    return false;
  }
}

/** スタックが拡張機能のスクリプトだけで構成されているか */
export function isFromExtension(stack: string | undefined): boolean {
  if (!stack) return false;
  return /(?:chrome|moz|safari|safari-web|ms-browser)-extension:\/\//i.test(stack);
}

// ---------------------------------------------------------------- 除外ルール

const BOT_UA =
  /bot|crawler|spider|crawling|headlesschrome|lighthouse|phantomjs|slurp|facebookexternalhit/i;

export type DropReason = "extension" | "script-error" | "bot";

export function dropReason(event: BrowserEvent, userAgent: string | undefined): DropReason | null {
  if (userAgent && BOT_UA.test(userAgent)) return "bot";
  // 別オリジンのスクリプトで起きたエラーは中身が見えず "Script error." になる
  if (/^Script error\.?$/i.test(event.message.trim())) return "script-error";
  if (isFromExtension(event.stack)) return "extension";
  return null;
}

// ---------------------------------------------------------------- マスク

/** URL のクエリ文字列の値を伏せる。キーは残す */
export function maskUrl(raw: string): string {
  const q = raw.indexOf("?");
  if (q === -1) return raw;
  const hash = raw.indexOf("#", q);
  const query = raw.slice(q + 1, hash === -1 ? undefined : hash);
  const masked = query
    .split("&")
    .map((pair) => {
      if (pair === "") return pair;
      const eq = pair.indexOf("=");
      return eq === -1 ? pair : `${pair.slice(0, eq)}=[Filtered]`;
    })
    .join("&");
  return `${raw.slice(0, q)}?${masked}${hash === -1 ? "" : raw.slice(hash)}`;
}

const URL_IN_TEXT = /\b(?:https?:\/\/|\/)[^\s"'<>()]*\?[^\s"'<>()]*/g;

/** 文中に現れる URL のクエリ文字列も伏せる */
export function maskUrlsInText(text: string): string {
  return text.replace(URL_IN_TEXT, (m) => maskUrl(m));
}

/** コンシューマで保存前に適用する整形。長さの上限とクエリ文字列のマスク */
export function sanitizeEvent(event: BrowserEvent): BrowserEvent {
  return {
    ...event,
    type: event.type.slice(0, 200),
    message: maskUrlsInText(event.message.slice(0, MAX_MESSAGE_LENGTH)),
    stack: event.stack ? maskUrlsInText(event.stack.slice(0, MAX_STACK_LENGTH)) : undefined,
    url: event.url ? maskUrl(event.url) : undefined,
    request: event.request
      ? { ...event.request, url: event.request.url ? maskUrl(event.request.url) : undefined }
      : undefined,
  };
}

// ---------------------------------------------------------------- フィンガープリント

/** 数値、UUID、16進数列、URL をプレースホルダーに置き換える */
export function normalizeMessage(message: string): string {
  return message
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>()]+/gi, "<url>")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<uuid>")
    .replace(/\b0x[0-9a-f]+\b/gi, "<hex>")
    .replace(/\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{8,}\b/gi, "<hex>")
    .replace(/\d+(?:\.\d+)?/g, "<n>")
    .trim();
}

// "app-3f9a.js"、"index.BxK2jF9a.js"、"chunk-5f2c8d1e.mjs" などのビルドハッシュ。
// 8文字以上は数字か大文字小文字の混在を含むものだけ（"app.component.js" は残す）
const HASHED_BASENAME =
  /^(.+?)[-.](?:(?=[A-Za-z0-9_]*(?:\d|[a-z][A-Za-z0-9_]*[A-Z]|[A-Z][A-Za-z0-9_]*[a-z]))[A-Za-z0-9_]{8,}|(?=[0-9a-f]*\d)[0-9a-f]{4,})(\.(?:m?js|cjs|jsx|ts|tsx))$/;

/** フレームのファイルパスからオリジン、クエリ、ビルドハッシュを除く */
export function stripBuildHash(file: string): string {
  let path = file;
  try {
    const url = new URL(file);
    path = url.pathname;
  } catch {
    path = file.split(/[?#]/)[0] ?? file;
  }
  const slash = path.lastIndexOf("/");
  const dir = path.slice(0, slash + 1);
  const base = path.slice(slash + 1);
  const m = HASHED_BASENAME.exec(base);
  return m ? `${dir}${m[1]}${m[2]}` : path;
}

/** 最上位のアプリ内フレーム。なければ最上位のフレーム */
export function culpritOf(frames: StackFrame[]): string | null {
  const top = frames.find((f) => f.inApp) ?? frames[0];
  return top ? stripBuildHash(top.file) : null;
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * エラーの型、正規化したメッセージ、最上位のアプリ内フレームのファイル名を連結した SHA-256。
 * 行番号と関数名は含めない（リリースのたびに変わるため）。
 */
export async function fingerprintOf(event: BrowserEvent, culprit: string | null): Promise<string> {
  if (event.fingerprint && event.fingerprint.length > 0) {
    return sha256Hex(`custom\n${event.fingerprint.join("\n")}`);
  }
  return sha256Hex([event.type, normalizeMessage(event.message), culprit ?? ""].join("\n"));
}

/** issue の ID はプロジェクトとフィンガープリントから決める。並行するバッチでも同じ ID になる */
export async function issueIdOf(projectId: string, fingerprint: string): Promise<string> {
  return (await sha256Hex(`${projectId}\n${fingerprint}`)).slice(0, 32);
}
