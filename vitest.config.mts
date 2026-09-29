import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./test/setup.ts"],
    include: ["test/**/*.test.{ts,tsx}"],
    restoreMocks: false,
    testTimeout: 15000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}"],
      reporter: ["text", "html", "json-summary"],
      thresholds: { statements: 95, lines: 95, functions: 95, branches: 85 },
    },
  },
});
