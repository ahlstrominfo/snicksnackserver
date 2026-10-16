import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations("./migrations");
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          // Låg gräns i testerna så att 413 går att prova utan 100 MB.
          bindings: { TEST_MIGRATIONS: migrations, ADMIN_PASSWORD: "testlösen", MAX_BYTES: "20000" },
        },
      }),
    ],
    test: { setupFiles: ["./test/setup.ts"] },
  };
});
