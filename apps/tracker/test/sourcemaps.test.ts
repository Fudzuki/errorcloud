import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { parseTarget } from "../src/worker/api/sourcemaps";
import { call, createProject } from "./helpers";

const MAP = JSON.stringify({
  version: 3,
  sources: ["src/app.ts"],
  names: [],
  mappings: "AAAA",
  sourcesContent: ["throw new Error('x')"],
});

describe("ソースマップ", () => {
  it("パスを分解し、危ないパスを拒否する", () => {
    expect(parseTarget("/api/sourcemaps/my-site/2026.11.17-1/assets/app-3f9a.js.map")).toEqual({
      projectId: "my-site",
      release: "2026.11.17-1",
      path: "assets/app-3f9a.js.map",
    });
    // リリース名の "/" はエンコードして1区間にする
    expect(parseTarget("/api/sourcemaps/p/feature%2Fx/app.js.map")).toMatchObject({
      release: "feature/x",
    });
    expect(parseTarget("/api/sourcemaps/p/r/../secret.map")).toBeTypeOf("string");
    expect(parseTarget("/api/sourcemaps/p/r/app.js")).toBeTypeOf("string");
    expect(parseTarget("/api/sourcemaps/p/r//app.js.map")).toBeTypeOf("string");
  });

  it("アップロードして取得でき、リリースが記録される", async () => {
    const p = await createProject();
    const path = `/api/sourcemaps/${p.id}/2026.11.17-1/assets/app-3f9a.js.map`;

    const put = await call(path, { method: "PUT", body: MAP });
    expect(put.status).toBe(201);
    expect(await put.json()).toMatchObject({
      key: `sourcemaps/${p.id}/2026.11.17-1/assets/app-3f9a.js.map`,
    });

    const get = await call(path);
    expect(get.status).toBe(200);
    expect(get.headers.get("Cache-Control")).toContain("private");
    expect(await get.text()).toBe(MAP);

    const rel = await env.DB.prepare("SELECT release FROM releases WHERE project_id = ?")
      .bind(p.id)
      .first<{ release: string }>();
    expect(rel?.release).toBe("2026.11.17-1");
  });

  it("存在しないプロジェクト、JSON でない本文、ないファイルを拒否する", async () => {
    const p = await createProject();
    expect(
      (await call("/api/sourcemaps/nope/r/a.js.map", { method: "PUT", body: MAP })).status,
    ).toBe(404);
    expect(
      (await call(`/api/sourcemaps/${p.id}/r/a.js.map`, { method: "PUT", body: "<html>" })).status,
    ).toBe(400);
    expect((await call(`/api/sourcemaps/${p.id}/r/missing.js.map`)).status).toBe(404);
  });

  it("プロジェクトを消すとソースマップも消える", async () => {
    const p = await createProject();
    await call(`/api/sourcemaps/${p.id}/r/a.js.map`, { method: "PUT", body: MAP });
    expect((await call(`/api/projects/${p.id}`, { method: "DELETE" })).status).toBe(204);
    // R2 の削除は waitUntil で走るので、直接消して確かめる代わりに一覧を見る
    await new Promise((r) => setTimeout(r, 50));
    const list = await env.BUCKET.list({ prefix: `sourcemaps/${p.id}/` });
    expect(list.objects).toHaveLength(0);
  });
});
