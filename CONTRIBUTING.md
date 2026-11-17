# コントリビューションガイド

errorcloud に関心を持ってくれてありがとう。バグ報告、機能の提案、Pull Request のどれも歓迎する。

参加する前に [行動規範](CODE_OF_CONDUCT.md) を読んでほしい。脆弱性は Issue ではなく [SECURITY.md](SECURITY.md) の方法で報告してほしい。

## Issue

- バグ報告と機能の提案は、[Issue](https://github.com/Fudzuki/errorcloud/issues/new/choose) のテンプレートから作る
- 作る前に、同じ内容の Issue がないか検索してほしい

## Pull Request

小さな修正（誤字、ドキュメント、明らかなバグ）はそのまま Pull Request を送ってよい。大きな変更や新機能は、先に Issue で方針を相談してもらえると、作業が無駄になりにくい。

### 手順

1. リポジトリをフォークし、`development` から作業用のブランチを切る
2. [README](README.md#セットアップ) の手順で開発環境を用意する
3. 変更を加え、必要ならテストを足す
4. 次のコマンドがすべて通ることを確かめる

   ```sh
   pnpm lint
   pnpm typecheck
   pnpm test
   pnpm build
   ```

5. `development` 向けに Pull Request を作り、テンプレートに沿って説明を書く

`development` と `main` には Pull Request を通してだけ変更を入れる。直接のプッシュや force push はできない設定になっている。

### リリースの流れ

- 既定ブランチは `development`。Pull Request はすべて `development` に入れる
- `development` に変更が入ると、`main` へのリリース PR（`リリース: development → main`）が自動で作られる。すでにあれば本文が更新される（`.github/workflows/release-pr.yml`）
- リリース PR を **Create a merge commit** でマージすると、`main` への push で npm への公開が動く（README の「パッケージの公開」）

### 変更するときの注意

- 整形と lint は [Biome](https://biomejs.dev/) に任せる。`pnpm format` で自動修正できる
- D1 のスキーマを変えるときは、既存のマイグレーションを書き換えず、`apps/tracker/migrations/` に連番の SQL を追加する
- `apps/tracker/wrangler.jsonc` を変えたら、`apps/tracker` で `pnpm cf-typegen` を実行し、`worker-configuration.d.ts` も一緒にコミットする
- 画面の見た目が変わる場合は、Pull Request にスクリーンショットを貼ってほしい

## ライセンス

送ってもらった変更は、このリポジトリと同じ [MIT ライセンス](LICENSE) で公開することに同意したものとして扱う。
