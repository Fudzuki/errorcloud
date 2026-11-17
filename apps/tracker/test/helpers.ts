import { exports } from "cloudflare:workers";
import type { BrowserEvent, Project, ProjectInput } from "../src/shared/types";

export function call(path: string, init?: RequestInit): Promise<Response> {
  return exports.default.fetch(`http://localhost${path}`, init);
}

export async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await call(path, init);
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

let seq = 0;

export async function createProject(input: ProjectInput = {}): Promise<Project> {
  seq++;
  return json<Project>("/api/projects", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: `Project ${seq}`, id: `p${seq}-${Date.now()}`, ...input }),
  });
}

export function browserEvent(overrides: Partial<BrowserEvent> = {}): BrowserEvent {
  return {
    ts: Date.now(),
    type: "TypeError",
    message: "Cannot read properties of undefined (reading 'id')",
    stack:
      "TypeError: Cannot read properties of undefined (reading 'id')\n" +
      "    at r (https://example.com/assets/app-3f9a2c1d.js:1:2345)\n" +
      "    at https://example.com/assets/vendor-9b8c7d6e.js:2:100",
    url: "https://example.com/items/42?token=secret",
    kind: "error",
    ...overrides,
  };
}
