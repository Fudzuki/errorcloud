import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { Issue, IssueStats, Overview, Page, Project } from "../src/shared/types";
import type { IngestMessage } from "../src/worker/env";
import { processMessages } from "../src/worker/pipeline/consumer";
import { browserEvent, call, createProject, json } from "./helpers";

const JSON_HEADERS = { "Content-Type": "application/json" };

function ingest(p: Project, events: unknown[], extra: object = {}, receivedAt = Date.now()) {
  const msg: IngestMessage = {
    kind: "browser",
    projectId: p.id,
    receivedAt,
    body: JSON.stringify({ key: p.publicKey, events, ...extra }),
  };
  return processMessages(env, [msg]);
}

describe("GET /api/health", () => {
  it("D1 に届けば ok", async () => {
    expect(await json("/api/health")).toEqual({ ok: true });
  });
});

describe("プロジェクト", () => {
  it("作成、一覧、編集、キー再発行、削除", async () => {
    const created = await json<Project>("/api/projects", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        name: "My Site",
        allowedOrigins: ["https://my.example/", "https://my.example"],
      }),
    });
    expect(created).toMatchObject({
      id: "my-site",
      name: "My Site",
      allowedOrigins: ["https://my.example"],
      retentionDays: 90,
      dailyEventLimit: 5000,
    });
    expect(created.publicKey).toMatch(/^pk_[0-9a-f]{32}$/);

    const dup = await call("/api/projects", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ name: "My Site" }),
    });
    expect(dup.status).toBe(409);

    const list = await json<Project[]>("/api/projects");
    expect(list.some((p) => p.id === "my-site")).toBe(true);

    const patched = await json<Project>("/api/projects/my-site", {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ retentionDays: 30, rotateKey: true }),
    });
    expect(patched.retentionDays).toBe(30);
    expect(patched.publicKey).not.toBe(created.publicKey);

    // 古いキーでは受け付けない
    const old = await call("/_e/v1/events", {
      method: "POST",
      body: JSON.stringify({ key: created.publicKey, events: [] }),
    });
    expect(old.status).toBe(401);

    expect((await call("/api/projects/my-site", { method: "DELETE" })).status).toBe(204);
    expect((await call("/api/projects/my-site", { method: "DELETE" })).status).toBe(404);
  });

  it("不正な入力は 400", async () => {
    const bad = [
      {},
      { name: "" },
      { name: "x", allowedOrigins: ["ftp://x"] },
      { name: "x", retentionDays: 0 },
      { name: "x", id: "Bad ID" },
    ];
    for (const body of bad) {
      const res = await call("/api/projects", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify(body),
      });
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
  });

  it("削除するとイベントもまとめて消える", async () => {
    const p = await createProject();
    await ingest(p, [browserEvent()]);
    await call(`/api/projects/${p.id}`, { method: "DELETE" });
    const left = await env.DB.prepare("SELECT COUNT(*) AS n FROM issues WHERE project_id = ?")
      .bind(p.id)
      .first<{ n: number }>();
    expect(left?.n).toBe(0);
  });
});

describe("issue 一覧", () => {
  it("状態、環境、リリースで絞り込み、カーソルでページを送る", async () => {
    const p = await createProject();
    const now = Date.now();
    for (let i = 0; i < 5; i++) {
      await ingest(
        p,
        [browserEvent({ type: `Error${i}` })],
        { environment: i % 2 ? "staging" : "production", release: `r${i}` },
        now - (5 - i) * 1000,
      );
    }
    const page1 = await json<Page<Issue>>(`/api/projects/${p.id}/issues?limit=2`);
    expect(page1.items.map((i) => i.type)).toEqual(["Error4", "Error3"]);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = await json<Page<Issue>>(
      `/api/projects/${p.id}/issues?limit=2&cursor=${page1.nextCursor}`,
    );
    expect(page2.items.map((i) => i.type)).toEqual(["Error2", "Error1"]);
    const page3 = await json<Page<Issue>>(
      `/api/projects/${p.id}/issues?limit=2&cursor=${page2.nextCursor}`,
    );
    expect(page3.items.map((i) => i.type)).toEqual(["Error0"]);
    expect(page3.nextCursor).toBeNull();

    const staging = await json<Page<Issue>>(`/api/projects/${p.id}/issues?environment=staging`);
    expect(staging.items.map((i) => i.type)).toEqual(["Error3", "Error1"]);
    const r2 = await json<Page<Issue>>(`/api/projects/${p.id}/issues?release=r2`);
    expect(r2.items.map((i) => i.type)).toEqual(["Error2"]);

    await call(`/api/issues/${page1.items[0]?.id}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "resolved" }),
    });
    const resolved = await json<Page<Issue>>(`/api/projects/${p.id}/issues?status=resolved`);
    expect(resolved.items.map((i) => i.type)).toEqual(["Error4"]);

    const facets = await json<{ environments: string[]; releases: string[] }>(
      `/api/projects/${p.id}/facets`,
    );
    expect(facets.environments).toEqual(["production", "staging"]);
    expect(facets.releases).toHaveLength(5);
  });

  it("status の値が不正なら 400", async () => {
    const p = await createProject();
    expect((await call(`/api/projects/${p.id}/issues?status=nope`)).status).toBe(400);
    expect(
      (await call("/api/issues/x", { method: "PATCH", body: JSON.stringify({ status: "nope" }) }))
        .status,
    ).toBe(400);
  });
});

describe("時系列と概況", () => {
  it("issue の発生回数を時間ごとに返す", async () => {
    const p = await createProject();
    const now = Date.now();
    await ingest(p, [browserEvent(), browserEvent()], {}, now);
    await ingest(p, [browserEvent()], {}, now - 3_600_000);
    const { items } = await json<Page<Issue>>(`/api/projects/${p.id}/issues`);
    const stats = await json<IssueStats>(`/api/issues/${items[0]?.id}/stats?range=24h`);
    expect(stats.interval).toBe("hour");
    expect(stats.points).toHaveLength(24);
    expect(stats.points.at(-1)?.[1]).toBe(2);
    expect(stats.points.at(-2)?.[1]).toBe(1);

    const daily = await json<IssueStats>(`/api/issues/${items[0]?.id}/stats?range=30d`);
    expect(daily.interval).toBe("day");
    expect(daily.points.reduce((s, [, n]) => s + n, 0)).toBe(3);

    const overview = await json<Overview>("/api/overview");
    const row = overview.projects.find((x) => x.id === p.id);
    expect(row).toMatchObject({ unresolvedIssues: 1, events24h: 3 });
    expect(overview.series).toHaveLength(24);
  });
});

describe("存在しないもの", () => {
  it("404 を返す", async () => {
    expect((await call("/api/issues/none")).status).toBe(404);
    expect((await call("/api/events/none")).status).toBe(404);
    expect((await call("/api/nothing")).status).toBe(404);
  });
});
