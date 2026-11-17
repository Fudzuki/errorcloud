# @errorcloud/cli

[errorcloud](https://github.com/Fudzuki/errorcloud) にソースマップをアップロードする CLI。アップロードしておくと、ダッシュボードがスタックを元のファイル名・行番号・周辺のコードに戻して表示する。Node.js 24 以上で動く。

## 使い方

ビルドのたびに実行する。`--release` はブラウザ SDK の `release` と同じ値にする。

```sh
CF_ACCESS_CLIENT_ID=… CF_ACCESS_CLIENT_SECRET=… \
npx @errorcloud/cli sourcemaps upload \
  --url https://errors.example.com \
  --project my-site \
  --release 2026.11.17-1 \
  --dir ./dist \
  --delete-after
```

| オプション            | 内容                                                                     |
| --------------------- | ------------------------------------------------------------------------ |
| `--url <url>`         | errorcloud の URL                                                        |
| `--project <id>`      | プロジェクトの ID                                                        |
| `--release <name>`    | リリース名                                                               |
| `--dir <dir>`         | ビルド成果物のディレクトリ                                               |
| `--url-prefix <path>` | 配信時のパスの接頭辞（`dist` を `/static/` で配信しているなら `static`） |
| `--delete-after`      | アップロードした `.map` を成果物から削除する                             |
| `--dry-run`           | 送らずに、送るファイルとキーだけを表示する                               |

errorcloud の `/api/*` は Cloudflare Access の内側にあるので、Access のサービストークンを作ってアプリケーションのポリシーで許可し、`CF_ACCESS_CLIENT_ID` と `CF_ACCESS_CLIENT_SECRET` で渡す。

## ライセンス

MIT
