import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("tracker worker", () => {
  it("GET /api/health returns ok via D1", async () => {
    const res = await exports.default.fetch("http://localhost/api/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("POST /_e/v1/events enqueues and returns 202", async () => {
    const res = await exports.default.fetch("http://localhost/_e/v1/events", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify({ key: "pk_test", events: [] }),
    });
    expect(res.status).toBe(202);
  });

  it("rejects payloads over 64KB", async () => {
    const res = await exports.default.fetch("http://localhost/_e/v1/events", {
      method: "POST",
      body: "x".repeat(64 * 1024 + 1),
    });
    expect(res.status).toBe(413);
  });

  it("migrations created the schema", async () => {
    const { env } = await import("cloudflare:workers");
    const tables = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'issues'",
    ).all();
    expect(tables.results).toHaveLength(1);
  });
});
