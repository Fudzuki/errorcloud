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

/** Queue に積むメッセージ。1リクエストを1メッセージにする（技術定義書 3章） */
export type IngestMessage = {
  kind: "browser";
  projectId: string;
  receivedAt: number;
  userAgent?: string;
  body: string;
};
