# @errorcloud/browser

[errorcloud](https://github.com/Fudzuki/errorcloud) のブラウザ SDK。ブラウザで起きたエラーを捕捉し、自分の Cloudflare アカウントにデプロイした errorcloud に送る。

```sh
npm install @errorcloud/browser
```

## 使い方

アプリのエントリーポイントのできるだけ早い位置で `init` を呼ぶ。

```ts
import { captureException, init } from "@errorcloud/browser";

init({
  key: "pk_xxxxxxxx", // プロジェクトの公開キー
  endpoint: "/_e", // 送信先。既定は同一ドメインの /_e
  release: "2026.11.17-1",
  environment: "production",
  beforeSend: (event) => event, // 加工、または null で破棄
});

captureException(new Error("手動で送る"), { fingerprint: ["checkout"], extra: { orderId: 1 } });
```

error イベント、unhandledrejection、失敗した fetch（ネットワークエラーと 5xx、`cf-ray` 付き）を捕捉し、3 秒分を 60KB 以下のリクエストにまとめて送る。ページ離脱時は `sendBeacon` を使う。同じエラーは 1 ページ表示あたり 5 件まで。

サイトと errorcloud を別のドメインで動かしている場合は、`endpoint` を `https://errors.example.com/_e` のように指定し、プロジェクトの許可 Origin にサイトを登録する。

## オプション

| 名前            | 既定値   | 内容                                                |
| --------------- | -------- | --------------------------------------------------- |
| `key`           | （必須） | プロジェクトの公開キー                              |
| `endpoint`      | `/_e`    | 送信先                                              |
| `release`       |          | リリース名。ソースマップの `--release` と揃える     |
| `environment`   |          | 環境名                                              |
| `beforeSend`    |          | 送る前にイベントを加工する。`null` を返すと送らない |
| `captureFetch`  | `true`   | 失敗した fetch を捕捉するか                         |
| `flushInterval` | `3000`   | まとめ送りの間隔（ミリ秒）                          |
| `maxPerError`   | `5`      | 同じエラーを 1 ページ表示あたり何件まで送るか       |

## ライセンス

MIT
