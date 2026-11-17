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
cp .dev.vars.example .dev.vars        # ローカル用のシークレット
pnpm db:migrate:local                 # ローカルの D1 にスキーマを適用
pnpm dev                              # http://localhost:5173
```

`pnpm dev` は `@cloudflare/vite-plugin` で Worker とダッシュボードを同時に起動する。D1、R2、Queues はすべてローカル（`.wrangler/state`）で動き、Cloudflare アカウントは不要。

動作確認:

```sh
curl localhost:5173/api/health                         # {"ok":true}
curl -X POST localhost:5173/_e/v1/events -d '{}'       # 202（コンシューマのログが dev サーバーに出る）
```

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
