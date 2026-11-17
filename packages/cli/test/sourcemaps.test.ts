import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { planUploads, sourceMappingUrl, uploadSourcemaps, uploadUrl } from "../src/sourcemaps";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "errorcloud-cli-"));
  await mkdir(join(dir, "assets"));
  await mkdir(join(dir, "maps"));
  // 隣に .map がある
  await writeFile(join(dir, "assets/app-3f9a.js"), "x()\n//# sourceMappingURL=app-3f9a.js.map\n");
  await writeFile(join(dir, "assets/app-3f9a.js.map"), "{}");
  // sourceMappingURL が別の場所を指す
  await writeFile(join(dir, "assets/vendor-9b8c.js"), "y()\n//# sourceMappingURL=../maps/v.map");
  await writeFile(join(dir, "maps/v.map"), "{}");
  // どこからも参照されない .map
  await writeFile(join(dir, "orphan.css.map"), "{}");
  // インラインのソースマップは対象外
  await writeFile(
    join(dir, "inline.js"),
    "z()\n//# sourceMappingURL=data:application/json;base64,e30=",
  );
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("planUploads", () => {
  it("JavaScript の配信時のパスをキーにする", async () => {
    expect(await planUploads(dir)).toEqual([
      { file: join(dir, "assets/app-3f9a.js.map"), key: "assets/app-3f9a.js.map" },
      { file: join(dir, "maps/v.map"), key: "assets/vendor-9b8c.js.map" },
      { file: join(dir, "orphan.css.map"), key: "orphan.css.map" },
    ]);
  });

  it("--url-prefix を前に付ける", async () => {
    const plan = await planUploads(dir, "/static/");
    expect(plan[0]?.key).toBe("static/assets/app-3f9a.js.map");
  });
});

describe("sourceMappingUrl", () => {
  it("最後の指定を使い、data: と絶対 URL は除く", () => {
    expect(sourceMappingUrl("//# sourceMappingURL=a.map\n//# sourceMappingURL=b.map")).toBe(
      "b.map",
    );
    expect(sourceMappingUrl("/*# sourceMappingURL=c.map */")).toBe("c.map");
    expect(sourceMappingUrl("//# sourceMappingURL=data:x")).toBeUndefined();
    expect(sourceMappingUrl("//# sourceMappingURL=https://cdn/x.map")).toBeUndefined();
  });
});

describe("uploadSourcemaps", () => {
  it("サービストークンを付けて PUT し、--delete-after で成功した .map だけ消す", async () => {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, headers: init.headers as Record<string, string> });
      if (url.includes("orphan")) return Response.json({ error: "だめ" }, { status: 400 });
      return Response.json({}, { status: 201 });
    }) as typeof fetch;

    const result = await uploadSourcemaps({
      url: "https://errors.example.com/",
      project: "my-site",
      release: "feature/x",
      dir,
      deleteAfter: true,
      accessClientId: "id",
      accessClientSecret: "secret",
      fetch: fakeFetch,
      log: () => {},
    });
    expect(result.uploaded).toHaveLength(2);
    expect(result.failed[0]?.error).toBe("HTTP 400 だめ");
    expect(calls.map((c) => c.url).sort()).toContain(
      "https://errors.example.com/api/sourcemaps/my-site/feature%2Fx/assets/app-3f9a.js.map",
    );
    expect(calls[0]?.headers["CF-Access-Client-Id"]).toBe("id");

    expect((await readdir(join(dir, "assets"))).sort()).toEqual(["app-3f9a.js", "vendor-9b8c.js"]);
    expect(await readdir(dir)).toContain("orphan.css.map");
  });

  it("Access のログイン画面へのリダイレクトは失敗として扱う", async () => {
    const result = await uploadSourcemaps({
      url: "https://errors.example.com",
      project: "p",
      release: "r",
      dir,
      fetch: (async () => new Response(null, { status: 302 })) as unknown as typeof fetch,
      log: () => {},
    });
    expect(result.uploaded).toHaveLength(0);
    expect(result.failed[0]?.error).toContain("Cloudflare Access");
  });

  it("uploadUrl はパスの各区間をエンコードする", () => {
    expect(uploadUrl("https://x", "p", "1.0", "a b/c.js.map")).toBe(
      "https://x/api/sourcemaps/p/1.0/a%20b/c.js.map",
    );
  });
});
