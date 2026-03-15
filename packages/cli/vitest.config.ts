import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["__tests__/**/*.test.ts"],
    testTimeout: 10000,
    pool: "forks",
    poolOptions: {
      forks: {
        minForks: 1,
        maxForks: 8,
      },
    },
  },
});
