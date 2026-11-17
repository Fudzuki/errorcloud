import type { TraceRecord, WorkerEvent } from "./ingest/otlp";

// wrangler types が生成する Env に、シークレットと任意のバインディングを足した型

export type AppEnv = Env & {
  /** Cloudflare Access のチームドメイン（例: https://myteam.cloudflareaccess.com） */
  ACCESS_TEAM_DOMAIN?: string;
  /** Access アプリケーションの AUD タグ */
  ACCESS_AUD?: string;
  /** "true" のとき Access の検証を省く。ローカル開発（.dev.vars）専用 */
  DEV_DISABLE_ACCESS?: string;
  /** OTLP受信口の取り込みトークン（段階3） */
  INGEST_TOKEN?: string;
  /** Workers Rate Limiting バインディング。未設定なら流量制限をかけない（技術定義書 11章） */
  RATE_LIMITER?: RateLimit;
};

/**
 * Queue に積むメッセージ。1リクエストを1メッセージにする（技術定義書 3章）。
 * OTLP は受信口でエラーだけに絞り、128KB を超えるときだけ複数のメッセージに分ける。
 */
export type IngestMessage = BrowserMessage | WorkerMessage;

export type BrowserMessage = {
  kind: "browser";
  projectId: string;
  receivedAt: number;
  userAgent?: string;
  /** BrowserPayload の JSON。Sentry 互換の受信口（段階5）も変換してからこの形で積む */
  body: string;
};

/** OTLP 受信口（段階3）から。プロジェクトはコンシューマが Worker 名から引く */
export type WorkerMessage = {
  kind: "worker";
  receivedAt: number;
  events: WorkerEvent[];
  traces: TraceRecord[];
};
