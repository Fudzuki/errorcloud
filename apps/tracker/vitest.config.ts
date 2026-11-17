import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations("./migrations"),
          // 管理APIのテストでは Access の検証を省く。検証自体は access.test.ts で確かめる
          DEV_DISABLE_ACCESS: "true",
          // OTLP 受信口のテストが使うトークン。.dev.vars が無い CI でも同じ値にする
          INGEST_TOKEN: "dev-ingest-token",
        },
      },
    })),
  ],
  test: {
    setupFiles: ["./test/apply-migrations.ts"],
  },
});
