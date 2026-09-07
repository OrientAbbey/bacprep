import { defineConfig } from "vitest/config";

// Configuration vitest minimale : les tests visent les fonctions pures
// (lib/) — pas de rendu de composants, pas besoin du plugin React.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
