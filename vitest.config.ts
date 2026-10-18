import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations("./migrations");
  return {
    plugins: [
      cloudflareTest({
        // Mallen, så att testerna går direkt efter en klon (utan egen wrangler.jsonc).
        wrangler: { configPath: "./wrangler.example.jsonc" },
        miniflare: {
          // Låg gräns i testerna så att 413 går att prova utan 100 MB.
          bindings: { TEST_MIGRATIONS: migrations, ADMIN_PASSWORD: "testlösen", MAX_BYTES: "20000", AI_MAX_BYTES: "20000", KEY_SECRET: "testhemlighet" },
          // Gränserna per nyckel (samma avsändare och agentnyckel används i många tester) högt; gränserna per IP har
          // produktionens värden, och hjalp.ts ger varje anrop en egen IP om testet inte anger en.
          ratelimits: {
            RL_INLOGGNING: { namespace_id: "1001", simple: { limit: 5, period: 60 } },
            RL_REGISTER: { namespace_id: "1002", simple: { limit: 10, period: 60 } },
            RL_TOKEN: { namespace_id: "1003", simple: { limit: 30, period: 60 } },
            RL_GISSNING: { namespace_id: "1005", simple: { limit: 20, period: 60 } },
            RL_MOTTAGNING: { namespace_id: "1004", simple: { limit: 1000, period: 60 } },
            RL_AI: { namespace_id: "1006", simple: { limit: 1000, period: 60 } },
            RL_MCP: { namespace_id: "1007", simple: { limit: 1000, period: 60 } },
          },
        },
      }),
    ],
    test: { setupFiles: ["./test/setup.ts"] },
  };
});
