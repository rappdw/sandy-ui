import { defineConfig } from "@vscode/test-cli";

// Integration tests run inside a real (downloaded) VSCode instance with the
// extension loaded. They have access to the full vscode API at runtime;
// activate the extension via vscode.extensions.getExtension(...) or by
// invoking a contributed command.
//
// Workspace folder is an empty fixture dir so tests start from a known state;
// individual tests can open files / change settings as needed.

export default defineConfig({
  files: "out-integration/**/*.test.js",
  workspaceFolder: "./test/fixtures/empty-workspace",
  mocha: {
    ui: "bdd",
    timeout: 30_000,  // generous; first run downloads VSCode
  },
});
