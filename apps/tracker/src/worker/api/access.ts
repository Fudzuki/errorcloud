// Cloudflare Access の JWT 検証（技術定義書 8章）。
// ドメイン全体を Access で守ったうえで、Worker 側でも Cf-Access-Jwt-Assertion を検証し、
// Access を経由しない直接アクセス（workers.dev など）を拒否する。
import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../env";

type Jwk = JsonWebKey & { kid?: string };
export type KeyFetcher = (teamDomain: string) => Promise<Jwk[]>;

type JwtPayload = { aud?: string | string[]; exp?: number; nbf?: number; iss?: string };

function base64UrlDecode(input: string): Uint8Array<ArrayBuffer> {
  const pad = "=".repeat((4 - (input.length % 4)) % 4);
  const bin = atob((input + pad).replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function decodeJson<T>(part: string): T {
  return JSON.parse(new TextDecoder().decode(base64UrlDecode(part))) as T;
}

const KEY_TTL_MS = 60 * 60 * 1000;
const keyCache = new Map<string, { keys: Jwk[]; expires: number }>();

export const fetchAccessKeys: KeyFetcher = async (teamDomain) => {
  const hit = keyCache.get(teamDomain);
  if (hit && hit.expires > Date.now()) return hit.keys;
  const res = await fetch(`${teamDomain}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`Access certs: HTTP ${res.status}`);
  const { keys } = (await res.json()) as { keys: Jwk[] };
  keyCache.set(teamDomain, { keys, expires: Date.now() + KEY_TTL_MS });
  return keys;
};

export function normalizeTeamDomain(raw: string): string {
  const withScheme = raw.startsWith("http") ? raw : `https://${raw}`;
  return withScheme.replace(/\/+$/, "");
}

/** 検証に成功したら true。署名（RS256）、aud、iss、有効期限を確かめる */
export async function verifyAccessJwt(
  token: string,
  opts: { teamDomain: string; aud: string; getKeys?: KeyFetcher; now?: number },
): Promise<boolean> {
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const [h = "", p = "", s = ""] = parts;
  let header: { alg?: string; kid?: string };
  let payload: JwtPayload;
  try {
    header = decodeJson(h);
    payload = decodeJson(p);
  } catch {
    return false;
  }
  if (header.alg !== "RS256") return false;

  const teamDomain = normalizeTeamDomain(opts.teamDomain);
  const keys = await (opts.getKeys ?? fetchAccessKeys)(teamDomain);
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) return false;

  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    base64UrlDecode(s),
    new TextEncoder().encode(`${h}.${p}`),
  );
  if (!valid) return false;

  const now = Math.floor((opts.now ?? Date.now()) / 1000);
  const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!auds.includes(opts.aud)) return false;
  if (payload.iss !== teamDomain) return false;
  if (typeof payload.exp !== "number" || payload.exp < now) return false;
  if (typeof payload.nbf === "number" && payload.nbf > now + 60) return false;
  return true;
}

/** /api/* に掛けるミドルウェア */
export function requireAccess(getKeys?: KeyFetcher): MiddlewareHandler<{ Bindings: AppEnv }> {
  return async (c, next) => {
    if (c.env.DEV_DISABLE_ACCESS === "true") return next();

    const { ACCESS_TEAM_DOMAIN: teamDomain, ACCESS_AUD: aud } = c.env;
    if (!teamDomain || !aud) {
      return c.json(
        { error: "Cloudflare Access が未設定です（ACCESS_TEAM_DOMAIN と ACCESS_AUD）" },
        503,
      );
    }
    const token = c.req.header("Cf-Access-Jwt-Assertion");
    if (!token || !(await verifyAccessJwt(token, { teamDomain, aud, getKeys }))) {
      return c.json({ error: "unauthorized" }, 401);
    }
    return next();
  };
}
