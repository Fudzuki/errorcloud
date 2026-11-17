#!/usr/bin/env node
// ソースマップのアップロード用CLI（技術定義書 7章、段階2）
//
//   npx @errorcloud/cli sourcemaps upload \
//     --url https://errors.example.com --project my-site --release 2026.11.17-1 --dir ./dist
//
// トラッカーの /api/* は Cloudflare Access の内側にあるので、Access のサービストークンを
// 環境変数 CF_ACCESS_CLIENT_ID と CF_ACCESS_CLIENT_SECRET で渡す。
import { parseArgs } from "node:util";
import { uploadSourcemaps } from "./sourcemaps";

const USAGE = `Usage: errorcloud sourcemaps upload [options]

Options:
  --url <url>          トラッカーの URL（例: https://errors.example.com）
  --project <id>       プロジェクトの ID
  --release <name>     リリース名。SDK の release と同じ値にする
  --dir <dir>          ビルド成果物のディレクトリ（例: ./dist）
  --url-prefix <path>  配信時のパスの接頭辞（dist を /static/ で配信しているなら static）
  --delete-after       アップロードした .map を成果物から削除する
  --dry-run            送らずに、送るファイルとキーだけを表示する

Environment:
  CF_ACCESS_CLIENT_ID, CF_ACCESS_CLIENT_SECRET   Cloudflare Access のサービストークン
`;

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      url: { type: "string" },
      project: { type: "string" },
      release: { type: "string" },
      dir: { type: "string" },
      "url-prefix": { type: "string" },
      "delete-after": { type: "boolean" },
      "dry-run": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [group, command] = positionals;
  if (values.help || group !== "sourcemaps" || command !== "upload") {
    console.log(USAGE);
    return values.help ? 0 : 1;
  }

  const missing = (["url", "project", "release", "dir"] as const).filter((k) => !values[k]);
  if (missing.length > 0) {
    console.error(`次のオプションが必要です: ${missing.map((k) => `--${k}`).join(", ")}\n`);
    console.error(USAGE);
    return 1;
  }

  const id = process.env.CF_ACCESS_CLIENT_ID;
  const secret = process.env.CF_ACCESS_CLIENT_SECRET;
  if (!id || !secret) {
    console.warn(
      "CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET が未設定です。Access で保護されたトラッカーには送れません。",
    );
  }

  const result = await uploadSourcemaps({
    url: values.url as string,
    project: values.project as string,
    release: values.release as string,
    dir: values.dir as string,
    urlPrefix: values["url-prefix"],
    deleteAfter: values["delete-after"],
    dryRun: values["dry-run"],
    accessClientId: id,
    accessClientSecret: secret,
  });
  console.log(`\n${result.uploaded.length} 件アップロード、${result.failed.length} 件失敗`);
  return result.failed.length > 0 ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
