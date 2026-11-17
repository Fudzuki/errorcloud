#!/usr/bin/env bash
# リリース PR（development → main）の本文を組み立てて標準出力に書く。
# .github/workflows/release-pr.yml から呼ぶ。手元でも同じ本文を確かめられる:
#   git fetch origin && REPO=Fudzuki/errorcloud scripts/release/release-pr-body.sh
#
# 環境変数:
#   REPO  owner/name（必須。PR の検索に使う）
#   BASE  リリース先（既定 origin/main）
#   HEAD  リリース元（既定 origin/development）
#
# 含まれる PR は、HEAD の first-parent に並ぶコミットから GitHub の API で引く。
# マージコミット・squash・rebase のどれで development に入っても拾える。
# PR を通らずに入ったコミットは別に並べる。
set -euo pipefail

: "${REPO:?REPO（owner/name）を指定する}"
BASE="${BASE:-origin/main}"
HEAD="${HEAD:-origin/development}"
# PR の向き先（origin/development なら development）
HEAD_BRANCH="${HEAD#origin/}"

# main へのマージで npm に公開されるパッケージ（.github/workflows/publish.yml と合わせる）
PACKAGES=(packages/browser packages/cli)

prs_tsv="$(mktemp)"
orphans="$(mktemp)"
trap 'rm -f "$prs_tsv" "$orphans"' EXIT

while read -r sha; do
  found="$(gh api "repos/${REPO}/commits/${sha}/pulls" \
    --jq ".[] | select(.merged_at != null and .base.ref == \"${HEAD_BRANCH}\")
      | [.number, .title, .user.login, .merged_at] | @tsv")"
  if [ -n "$found" ]; then
    printf '%s\n' "$found" >>"$prs_tsv"
  else
    git log -1 --format='- %h %s' "$sha" >>"$orphans"
  fi
done < <(git rev-list --first-parent --reverse "${BASE}..${HEAD}")

# 1 つの PR が複数のコミットに当たる（rebase マージ）ので番号で重複を除き、マージ順に並べる
sort -t $'\t' -k1,1n -u "$prs_tsv" | sort -t $'\t' -k4,4 >"${prs_tsv}.sorted"
mv "${prs_tsv}.sorted" "$prs_tsv"
pr_count="$(wc -l <"$prs_tsv" | tr -d ' ')"

changed="$(git diff --name-only "${BASE}...${HEAD}")"

# パッケージの name と version を「name<TAB>version」で返す。そのリビジョンに無ければ空
pkg_info() {
  git show "$1:$2/package.json" 2>/dev/null | jq -r '[.name, .version] | @tsv' || true
}

echo "development に入った変更を main へ反映するリリース PR です。development に push されるたびに自動で更新されます。"
echo
echo "マージすると \`publish.yml\` が動き、npm にまだないバージョンのパッケージを公開します。"
echo
echo "> [!IMPORTANT]"
echo "> マージは **Create a merge commit** で行ってください。Squash や Rebase でマージすると development と main の履歴が分かれ、次のリリース PR に同じ変更がまた並び、衝突もしやすくなります。"
echo
echo "## 含まれる PR（${pr_count} 件）"
echo
if [ "$pr_count" = 0 ]; then
  echo "なし"
else
  # 本文の上限（65,536 文字）に収まるよう、件数が多いときは先頭だけ並べる
  head -n 200 "$prs_tsv" | while IFS=$'\t' read -r number title login _merged; do
    # タイトルの @ でメンションの通知を飛ばさない
    echo "- #${number} ${title//@/@<!-- -->}（${login}）"
  done
  if [ "$pr_count" -gt 200 ]; then
    echo "- ほか $((pr_count - 200)) 件"
  fi
fi
if [ -s "$orphans" ]; then
  echo
  echo "## PR を通らずに入ったコミット"
  echo
  head -n 50 "$orphans"
fi

echo
echo "## 公開されるパッケージ"
echo
echo "\`version\` が上がったパッケージです。npm にすでにあるバージョンなら公開はスキップされます。"
echo
bumped=0
unbumped=()
for dir in "${PACKAGES[@]}"; do
  head_info="$(pkg_info "$HEAD" "$dir")"
  [ -n "$head_info" ] || continue
  IFS=$'\t' read -r name head_version <<<"$head_info"
  base_version="$(pkg_info "$BASE" "$dir" | cut -f2)"
  if [ "$head_version" != "$base_version" ]; then
    bumped=1
    tag=latest
    case "$head_version" in *-*) tag=next ;; esac
    echo "- \`${name}\`: ${base_version:-（なし）} → **${head_version}**（タグ: ${tag}）"
  elif grep -qE "^${dir}/" <<<"$changed"; then
    unbumped+=("\`${name}\`")
  fi
done
if [ "$bumped" = 0 ]; then
  echo "なし"
fi

echo
echo "## マージ前の確認"
echo
echo "差分から自動で拾ったものです。該当が無ければ何もしなくてよいです。本文は development に push されるたびに作り直すので、チェックを付けても残りません。"
echo
any=0
if [ "${#unbumped[@]}" -gt 0 ]; then
  any=1
  echo "- [ ] ${unbumped[*]} に変更がありますが \`version\` が上がっていないので、公開されません。公開したいなら、先に \`version\` を上げる PR を development に入れてください。"
fi
if grep -qE '^\.github/workflows/publish\.yml$' <<<"$changed"; then
  any=1
  echo "- [ ] \`publish.yml\` が変わっています。npm の Trusted Publishing の設定（ファイル名・environment 名）と食い違っていないか確かめてください。"
fi
if grep -qE '^pnpm-lock\.yaml$' <<<"$changed"; then
  any=1
  echo "- [ ] 依存パッケージが変わっています。"
fi
if [ "$any" = 0 ]; then
  echo "なし"
fi

echo
echo "<details><summary>変更されたファイル（$(grep -c . <<<"$changed" || true) 件）</summary>"
echo
echo '```'
head -n 300 <<<"$changed"
echo '```'
echo
echo "</details>"
