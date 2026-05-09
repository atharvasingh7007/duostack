import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    // Run tests sequentially — some tests bind ports or write to disk
    // and parallel execution causes false failures
    pool: "forks",
    poolOptions: {
      forks: {
        singleFork: false,
        maxForks: 4,
      },
    },
    // Longer timeout for server integration tests
    testTimeout: 15_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov", "html"],
      include: ["src/core/**", "src/api/**", "src/mcp/**"],
      exclude: ["src/__tests__/**", "src/cli/**"],
      thresholds: {
        lines: 70,
        functions: 70,
        branches: 60,
      },
    },
  },
});
