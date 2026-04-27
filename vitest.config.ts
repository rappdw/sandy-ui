import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Pure-logic tests run in node — no jsdom needed for now. Add an env per
    // file via /// <reference> if any future tests need DOM.
    environment: "node",
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/**/*.ts"],
      // Webview-bound files exercise vscode/node-pty APIs and are best covered
      // by integration tests (@vscode/test-electron, post-0.2.0). Exclude from
      // unit coverage so the metric reflects reachable-from-unit-tests code.
      exclude: [
        "src/extension.ts",
        "src/projectsTree.ts",
        "src/**/webviewPanel.ts",
        "src/mocks/**",
      ],
    },
  },
});
