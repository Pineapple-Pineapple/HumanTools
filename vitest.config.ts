import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Side-panel modules touch `chrome` as they load; without this, importing one to test a pure
    // function in it throws before the test runs.
    setupFiles: ["./test/chrome-stub.ts"],
  },
});
