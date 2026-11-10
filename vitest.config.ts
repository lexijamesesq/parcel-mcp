import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// The OAuth library imports `cloudflare:workers`, which Node cannot load.
// Inline that package so Vite can point the import at the local stub.
export default defineConfig({
  resolve: {
    alias: {
      "cloudflare:workers": fileURLToPath(
        new URL("./test/cloudflare-workers-stub.ts", import.meta.url),
      ),
    },
  },
  ssr: {
    noExternal: ["@cloudflare/workers-oauth-provider"],
  },
  test: {
    server: {
      deps: {
        inline: ["@cloudflare/workers-oauth-provider"],
      },
    },
  },
});
