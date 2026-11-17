# errorcloud

自分の Cloudflare アカウントに Worker 1 本でデプロイするエラートラッカー。設計は「errorcloud 技術定義書」を参照。

## 構成

| パス               | 内容                                                       |
| ------------------ | ---------------------------------------------------------- |
| `apps/tracker`     | Worker 本体（Hono）とダッシュボード（React + Vite の SPA） |
| `packages/browser` | ブラウザ SDK（`@errorcloud/browser`）                      |
| `packages/cli`     | ソースマップのアップロード用 CLI（`@errorcloud/cli`）      |

## 必要なもの

- Node.js 24 以上
- pnpm 12.6.0

[mise](https://mise.jdx.dev/) を使っている場合は `mise install` でそろう。

## セットアップ

```sh
pnpm install

cd apps/tracker
cp .dev.vars.example .dev.vars        # ローカル用のシークレット（Access の検証を省く設定を含む）
pnpm dev                              # http://localhost:5173
```

`pnpm dev` は `@cloudflare/vite-plugin` で Worker とダッシュボードを同時に起動する。D1、R2、Queues はすべてローカル（`.wrangler/state`）で動き、Cloudflare アカウントは不要。D1 のマイグレーションは最初のリクエストで Worker が適用する（`pnpm db:migrate:local` で先に適用してもよい。記録は同じ `d1_migrations` テーブルに残る）。

動作確認:

```sh
curl localhost:5173/api/health   # {"ok":true}

# プロジェクトを作り、返ってきた publicKey でイベントを送る
curl -X POST localhost:5173/api/projects -H 'Content-Type: application/json' -d '{"name":"Demo"}'
curl -X POST localhost:5173/_e/v1/events \
  -d '{"key":"pk_…","events":[{"type":"TypeError","message":"x is undefined","kind":"error"}]}'
# 202。数秒後にコンシューマがまとめて処理し、ダッシュボードに issue が出る
```

## ブラウザSDK

```ts
import { captureException, init } from "@errorcloud/browser";

init({
  key: "pk_xxxxxxxx", // プロジェクトの公開キー
  endpoint: "/_e", // 同一ドメインのパス（既定値）
  release: "2026.11.17-1",
  environment: "production",
  beforeSend: (event) => event, // 加工、または null で破棄
});

captureException(new Error("手動で送る"), { fingerprint: ["checkout"], extra: { orderId: 1 } });
```

error イベント、unhandledrejection、失敗した fetch（ネットワークエラーと 5xx、`cf-ray` 付き）を捕捉し、3 秒分を 60KB 以下のリクエストにまとめて送る。ページ離脱時は `sendBeacon` を使う。同じエラーは 1 ページ表示あたり 5 件まで。

## よく使うコマンド

ルートで実行する。

| コマンド                    | 内容                                                            |
| --------------------------- | --------------------------------------------------------------- |
| `pnpm dev`                  | トラッカーの開発サーバー                                        |
| `pnpm test`                 | 全パッケージのテスト（トラッカーは Workers ランタイム上で実行） |
| `pnpm typecheck`            | 型チェック                                                      |
| `pnpm lint` / `pnpm format` | Biome による lint / 整形                                        |
| `pnpm build`                | 全パッケージのビルド                                            |

`apps/tracker/wrangler.jsonc` を変更したら、`apps/tracker` で `pnpm cf-typegen` を実行してバインディングの型（`worker-configuration.d.ts`）を作り直す。

マイグレーションは `apps/tracker/migrations/` に連番の SQL で追加する。テストは実行時にこのディレクトリのマイグレーションを自動で適用する。

## デプロイ

本番用の `routes` と D1 の `database_id` は `apps/tracker/wrangler.jsonc` に未設定。技術定義書 9 章に沿って設定してから `pnpm --filter @errorcloud/tracker deploy` を実行する。

管理用の `/api/*` は Worker 側でも Cloudflare Access の JWT を検証する。Access アプリケーションを作ったら、次の 2 つをシークレットに入れる（未設定のあいだ `/api/*` は 503 を返す）。

```sh
cd apps/tracker
pnpm wrangler secret put ACCESS_TEAM_DOMAIN   # https://<チーム名>.cloudflareaccess.com
pnpm wrangler secret put ACCESS_AUD           # Access アプリケーションの AUD タグ
```

受信口の流量制限には Workers Rate Limiting バインディング（`RATE_LIMITER`）を使う。使えないプランでは `wrangler.jsonc` の `ratelimits` を消せば、流量制限なしで動く（1 日の上限は効く）。

## コントリビューション

バグ報告や Pull Request を歓迎する。手順は [CONTRIBUTING.md](CONTRIBUTING.md) を参照。脆弱性は [SECURITY.md](SECURITY.md) の方法で非公開に報告してほしい。

## ライセンス

[MIT](LICENSE)
