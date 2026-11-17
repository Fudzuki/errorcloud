import { Hono } from "hono";
import { beforeAll, describe, expect, it } from "vitest";
import { requireAccess, verifyAccessJwt } from "../src/worker/api/access";
import type { AppEnv } from "../src/worker/env";

const TEAM = "https://team.cloudflareaccess.com";
const AUD = "aud-123";

let privateKey: CryptoKey;
let publicJwk: JsonWebKey & { kid: string };

function b64url(data: Uint8Array | string): string {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function sign(payload: object, kid = "k1"): Promise<string> {
  const head = b64url(JSON.stringify({ alg: "RS256", kid, typ: "JWT" }));
  const body = b64url(JSON.stringify(payload));
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    privateKey,
    new TextEncoder().encode(`${head}.${body}`),
  );
  return `${head}.${body}.${b64url(new Uint8Array(sig))}`;
}

const getKeys = async () => [publicJwk];
const valid = () => ({ aud: [AUD], iss: TEAM, exp: Math.floor(Date.now() / 1000) + 600 });

beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  privateKey = pair.privateKey;
  publicJwk = {
    ...((await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey),
    kid: "k1",
  };
});

describe("verifyAccessJwt", () => {
  it("正しい署名、aud、iss、期限なら通す", async () => {
    expect(
      await verifyAccessJwt(await sign(valid()), { teamDomain: TEAM, aud: AUD, getKeys }),
    ).toBe(true);
  });

  it("aud、iss、期限、鍵が違えば拒否する", async () => {
    const opts = { teamDomain: TEAM, aud: AUD, getKeys };
    expect(await verifyAccessJwt(await sign({ ...valid(), aud: ["other"] }), opts)).toBe(false);
    expect(await verifyAccessJwt(await sign({ ...valid(), iss: "https://evil" }), opts)).toBe(
      false,
    );
    expect(await verifyAccessJwt(await sign({ ...valid(), exp: 1 }), opts)).toBe(false);
    expect(await verifyAccessJwt(await sign(valid(), "unknown"), opts)).toBe(false);
    expect(await verifyAccessJwt("a.b.c", opts)).toBe(false);
  });

  it("改ざんされた本文を拒否する", async () => {
    const [h, , s] = (await sign(valid())).split(".");
    const forged = `${h}.${b64url(JSON.stringify({ ...valid(), aud: [AUD, "x"] }))}.${s}`;
    expect(await verifyAccessJwt(forged, { teamDomain: TEAM, aud: AUD, getKeys })).toBe(false);
  });
});

describe("requireAccess", () => {
  const app = new Hono<{ Bindings: AppEnv }>();
  app.use("*", requireAccess(getKeys));
  app.get("/api/x", (c) => c.text("ok"));

  const env = { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD } as AppEnv;

  it("JWT がなければ 401、正しければ通す", async () => {
    expect((await app.request("/api/x", {}, env)).status).toBe(401);
    const res = await app.request(
      "/api/x",
      { headers: { "Cf-Access-Jwt-Assertion": await sign(valid()) } },
      env,
    );
    expect(res.status).toBe(200);
  });

  it("Access が未設定なら 503 で止める", async () => {
    expect((await app.request("/api/x", {}, {} as AppEnv)).status).toBe(503);
  });
});
