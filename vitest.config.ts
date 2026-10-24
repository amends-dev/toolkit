import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    // Separate processes preserve Bun's native server APIs.
    pool: "forks",
    maxWorkers: 4,
    environment: "node",
    // Tests own fresh sources and scoped resources; reuse workers and their module cache.
    isolate: false,
    // The conformance suites start servers and wait on calls; the 5 s default is too tight on CI.
    testTimeout: 20_000,
    include: ["packages/*/test/**/*.test.ts"]
  }
})
