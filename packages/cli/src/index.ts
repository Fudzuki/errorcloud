#!/usr/bin/env node
// ソースマップのアップロード用CLI（技術定義書 7章）。現時点では雛形。
import { parseArgs } from "node:util";

const { positionals } = parseArgs({ allowPositionals: true, strict: false });
const [group, command] = positionals;

if (group === "sourcemaps" && command === "upload") {
  console.error("sourcemaps upload は未実装です");
  process.exit(1);
}

console.log(
  "Usage: errorcloud sourcemaps upload --url <url> --project <id> --release <name> --dir <dir>",
);
