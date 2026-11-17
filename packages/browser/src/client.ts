// SDK の本体。ブラウザの API には触らず、送信は Transport に任せる（テストしやすくするため）。

export type EventKind = "error" | "unhandledrejection" | "fetch" | "manual";

export type ErrorEvent = {
  ts: number;
  type: string;
  message: string;
  stack?: string;
  url?: string;
  kind: EventKind;
  request?: { url?: string; method?: string; status?: number; rayId?: string };
  fingerprint?: string[];
  extra?: Record<string, unknown>;
};

export type ClientOptions = {
  /** プロジェクトの公開キー */
  key: string;
  release?: string;
  environment?: string;
  /** 送る前にイベントを加工する。null を返すと送らない */
  beforeSend?: (event: ErrorEvent) => ErrorEvent | null;
  /** まとめ送りの間隔（ミリ秒）。既定は 3000 */
  flushInterval?: number;
  /** 同じエラーを1ページ表示あたり何件まで送るか。既定は 5 */
  maxPerError?: number;
};

export type Transport = {
  /** beacon が true のときはページ離脱中。sendBeacon を使う */
  send(body: string, beacon: boolean): void;
};

/** 1リクエストの上限。受信口は 64KB で、少し余裕を持たせる */
export const MAX_REQUEST_BYTES = 60 * 1024;
const MAX_STACK = 16 * 1024;
const MAX_MESSAGE = 2000;

const encoder = new TextEncoder();
const byteLength = (s: string) => encoder.encode(s).byteLength;

export function truncateEvent(event: ErrorEvent): ErrorEvent {
  return {
    ...event,
    message: event.message.slice(0, MAX_MESSAGE),
    stack: event.stack?.slice(0, MAX_STACK),
  };
}

/** イベントを、1リクエストが maxBytes を超えないように分ける */
export function buildBodies(
  header: { key: string; release?: string; environment?: string },
  events: ErrorEvent[],
  maxBytes = MAX_REQUEST_BYTES,
): string[] {
  const bodies: string[] = [];
  // '{"key":…,"events":[' の部分。末尾の "]}" は後で付ける
  const head = JSON.stringify({ ...header, events: [] }).slice(0, -2);
  const base = byteLength(head) + 2;
  let current: string[] = [];
  let size = base;

  const push = () => {
    if (current.length === 0) return;
    bodies.push(`${head}${current.join(",")}]}`);
    current = [];
    size = base;
  };

  for (const event of events) {
    let json = JSON.stringify(event);
    let len = byteLength(json);
    if (base + len > maxBytes) {
      // 1件で上限を超えるときはスタックを削る。それでも超えるなら諦める
      json = JSON.stringify({ ...event, stack: undefined, extra: undefined });
      len = byteLength(json);
      if (base + len > maxBytes) continue;
    }
    if (current.length > 0 && size + 1 + len > maxBytes) push();
    size += current.length > 0 ? len + 1 : len;
    current.push(json);
  }
  push();
  return bodies;
}

export class Client {
  private queue: ErrorEvent[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private seen = new Map<string, number>();

  constructor(
    readonly options: ClientOptions,
    private readonly transport: Transport,
  ) {}

  capture(event: ErrorEvent): void {
    try {
      const key = `${event.type}\n${event.message}\n${event.stack?.split("\n", 3).join("\n") ?? ""}`;
      const count = this.seen.get(key) ?? 0;
      if (count >= (this.options.maxPerError ?? 5)) return;
      this.seen.set(key, count + 1);

      const processed = this.options.beforeSend ? this.options.beforeSend(event) : event;
      if (!processed) return;
      this.queue.push(truncateEvent(processed));
      this.timer ??= setTimeout(() => this.flush(false), this.options.flushInterval ?? 3000);
    } catch {
      // SDK の失敗でサイトを止めない
    }
  }

  flush(beacon: boolean): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.queue.length === 0) return;
    const events = this.queue;
    this.queue = [];
    try {
      const { key, release, environment } = this.options;
      for (const body of buildBodies({ key, release, environment }, events)) {
        this.transport.send(body, beacon);
      }
    } catch {
      // 送信の失敗は握りつぶす
    }
  }
}

// ---------------------------------------------------------------- 例外からイベントへ

function errorName(err: unknown): string {
  if (err instanceof Error) return err.name || "Error";
  if (typeof err === "object" && err !== null && "name" in err && typeof err.name === "string") {
    return err.name;
  }
  return "Error";
}

export function eventFromError(
  err: unknown,
  kind: EventKind,
  pageUrl: string | undefined,
): ErrorEvent {
  let message: string;
  let stack: string | undefined;
  if (err instanceof Error) {
    message = err.message;
    stack = err.stack;
  } else if (typeof err === "string") {
    message = err;
  } else {
    try {
      message = JSON.stringify(err) ?? String(err);
    } catch {
      message = String(err);
    }
  }
  return {
    ts: Date.now(),
    type:
      kind === "unhandledrejection" && !(err instanceof Error)
        ? "UnhandledRejection"
        : errorName(err),
    message,
    stack,
    url: pageUrl,
    kind,
  };
}
