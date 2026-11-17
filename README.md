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

```sh
npm install @errorcloud/browser
```

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

### Sentry の SDK から送る

Sentry の SDK をそのまま使う場合は、DSN を次の形にする。SDK は `/_e/sentry/api/1/envelope/` に送るので、ルートと Access のバイパス設定はブラウザ SDK と共通で済む。envelope のうち `event` アイテムだけを issue にし、セッションやトランザクションなどは捨てる（Queue には積まない）。末尾の `1` は SDK の DSN の形式に合わせるための固定値で、プロジェクトは公開キーで決まる。

```
https://<公開キー>@<サイトのドメイン>/_e/sentry/1
```

## ソースマップ

ビルドのたびにソースマップをアップロードすると、ダッシュボードがブラウザ内でスタックを元のファイル名・行番号・周辺のコードに戻して表示する。`--release` は SDK の `release` と同じ値にする。

```sh
CF_ACCESS_CLIENT_ID=… CF_ACCESS_CLIENT_SECRET=… \
npx @errorcloud/cli sourcemaps upload \
  --url https://errors.example.com \
  --project my-site \
  --release 2026.11.17-1 \
  --dir ./dist \
  --delete-after          # アップロードした .map を公開用の成果物から消す
```

JavaScript ごとに `sourceMappingURL` が指す `.map`（なければ隣の `<ファイル名>.map`）を探し、配信時のパス + `.map` をキーにして `PUT /api/sourcemaps/:project/:release/*` に送る。`dist` をサイトのルート以外で配信しているときは `--url-prefix static` のように指定する。`/api/*` は Access の内側にあるので、Access のサービストークンを作り、アプリケーションのポリシーで許可しておく。

## Workers のエラーとトレース（OTLP）

監視対象の Worker のログとトレースを OTLP で受け、エラーのログ（重大度 ERROR 以上か例外の属性を持つもの）と、エラーを含むトレースだけを残す。

1. 取り込みトークンをシークレットに入れる: `pnpm wrangler secret put INGEST_TOKEN`
2. Cloudflare ダッシュボードの Observability > Destinations で送信先を 2 つ作る。エンドポイントは `https://errors.example.com/otlp/v1/logs` と `/otlp/v1/traces`、カスタムヘッダーに `Authorization: Bearer <取り込みトークン>`
3. 監視対象 Worker の wrangler 設定で送信先を指定する

   ```jsonc
   "observability": {
     "traces": { "enabled": true, "destinations": ["errorcloud-traces"] },
     "logs": { "enabled": true, "destinations": ["errorcloud-logs"] }
   }
   ```

4. エラーが届くと、ダッシュボードの概況に「未割り当ての Worker」として出るので、プロジェクトに割り当てる（プロジェクト設定から先に登録してもよい）。割り当てるまでのエラーは件数だけ数えて捨てる

Worker 名は `cloudflare.script_name`、`service.name`、`faas.name` の順に属性から読む。読めない場合は送信先の URL に `?worker=<名前>` を付ける。ブラウザの失敗した fetch に付いた `cf-ray` と Worker 側の `cloudflare.ray_id` が一致すると、イベントの画面に Worker 側のエラーとトレースが並ぶ。

実データの形式（技術定義書 11 章の OTLP 関連の検証項目）は未確認で、公式ドキュメントの属性名と OpenTelemetry の意味規約（`exception.*`）を前提にしている。違っていた場合は `apps/tracker/src/worker/ingest/otlp.ts` 冒頭の定数を直す。

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

## MCP サーバー

ルートの `.mcp.json` に、このリポジトリの開発で使う MCP サーバーを登録している。Claude Code などの MCP クライアントでリポジトリを開くと、プロジェクト用のサーバーとして使うかどうかを確認される。

| 名前                       | 用途                                                         | 認証                        |
| -------------------------- | ------------------------------------------------------------ | --------------------------- |
| `cloudflare-docs`          | Workers、D1、R2、Queues などの Cloudflare ドキュメントの検索 | 不要                        |
| `cloudflare-bindings`      | 自分のアカウントの Worker、D1、R2 などの参照と操作           | Cloudflare の OAuth         |
| `cloudflare-observability` | デプロイした Worker のログと分析の参照                       | Cloudflare の OAuth         |
| `context7`                 | Hono、Vite、React などライブラリの最新ドキュメントの参照     | 不要                        |
| `playwright`               | ブラウザを操作してダッシュボードの動作を確かめる             | 不要（初回に `npx` で取得） |

`cloudflare-bindings` と `cloudflare-observability` は、初めて使うときにブラウザで Cloudflare へのログインを求められる（Claude Code では `/mcp` から認証する）。本番のリソースにも触れるので、操作を許可する前に対象のアカウントとリソースを確かめる。

## デプロイ

本番用の `routes` と D1 の `database_id` は `apps/tracker/wrangler.jsonc` に未設定。技術定義書 9 章に沿って設定してから `pnpm --filter @errorcloud/tracker deploy` を実行する。

管理用の `/api/*` は Worker 側でも Cloudflare Access の JWT を検証する。Access アプリケーションを作ったら、次の 2 つをシークレットに入れる（未設定のあいだ `/api/*` は 503 を返す）。

```sh
cd apps/tracker
pnpm wrangler secret put ACCESS_TEAM_DOMAIN   # https://<チーム名>.cloudflareaccess.com
pnpm wrangler secret put ACCESS_AUD           # Access アプリケーションの AUD タグ
pnpm wrangler secret put INGEST_TOKEN         # OTLP 受信口の取り込みトークン（未設定なら /otlp/* は 503）
```

受信口の流量制限には Workers Rate Limiting バインディング（`RATE_LIMITER`）を使う。使えないプランでは `wrangler.jsonc` の `ratelimits` を消せば、流量制限なしで動く（1 日の上限は効く）。

## パッケージの公開

`@errorcloud/browser` と `@errorcloud/cli` は npm の `@errorcloud` 組織で公開している。`package.json` の `version` を上げてから、ルートで次を実行する（`prepublishOnly` でビルドしてから公開される）。

```sh
npm login
pnpm --filter @errorcloud/browser --filter @errorcloud/cli publish
```

## コントリビューション

バグ報告や Pull Request を歓迎する。手順は [CONTRIBUTING.md](CONTRIBUTING.md) を参照。脆弱性は [SECURITY.md](SECURITY.md) の方法で非公開に報告してほしい。

## ライセンス

[MIT](LICENSE)
