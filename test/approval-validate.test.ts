import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { validateConfig } from "../src/approval/validate";

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sandy-ui-validate-test-")); });
afterEach(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ } });

describe("validateConfig — non-existent file", () => {
  // The tested behavior is: when the workspace .sandy/config doesn't exist,
  // there's nothing to validate, so we treat it as "no approval needed."
  // That's what lets sandy launch in a workspace that hasn't been
  // configured yet. Sandy itself never gets invoked in this case.
  it("returns approval_status='none_required' without invoking sandy", async () => {
    const result = await validateConfig(path.join(tmp, "does-not-exist", "config"));
    expect(result.error).toBeUndefined();
    expect(result.result).toBeDefined();
    expect(result.result?.approval_status).toBe("none_required");
  });
});
