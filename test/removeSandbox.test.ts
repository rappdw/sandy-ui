import { describe, it, expect } from "vitest";
import { isValidSandboxName, removeSandboxArgs, cleanSandyOutput, removalPlan } from "../src/state/removeSandbox";

// Delete Sandbox runs `sandy --remove-sandbox --sandbox NAME` instead of an
// rm -rf of sandy's private ~/.sandy/sandboxes layout.
describe("removeSandbox helpers", () => {
  it("accepts only names sandy's --sandbox accepts", () => {
    expect(isValidSandboxName("myproj-1a2b3c4d")).toBe(true);
    expect(isValidSandboxName("my.proj_x-1")).toBe(true);
    for (const bad of ["", ".hidden", "a/b", "../x", "a..b", "with space", "semi;colon"]) {
      expect(isValidSandboxName(bad), bad).toBe(false);
    }
  });

  it("dry-runs first and removes with --yes", () => {
    expect(removeSandboxArgs("p-1", true)).toEqual(["--remove-sandbox", "--sandbox", "p-1", "--dry-run"]);
    expect(removeSandboxArgs("p-1", false)).toEqual(["--remove-sandbox", "--sandbox", "p-1", "--yes"]);
  });

  // Real output of sandy main's --remove-sandbox --dry-run.
  const dryRun = "\nsandy --remove-sandbox: 1 sandbox target(s), 0 loose file(s)\n" +
    "  - gone-1a2b3c4d                  4.0K     workspace: /nonexistent/gone                        last used: (unknown)\n\n" +
    "\x1b[0;36m[sandy]\x1b[0m --dry-run: nothing removed.\n";

  it("turns the dry run into a plan without its 'nothing removed' footer", () => {
    const plan = removalPlan(dryRun);
    expect(plan.startsWith("sandy --remove-sandbox: 1 sandbox target(s)")).toBe(true);
    expect(plan).toContain("gone-1a2b3c4d");
    expect(plan).not.toContain("nothing removed");
    expect(plan).not.toContain("\x1b");
  });

  it("strips colour codes and sandy's prefix, and truncates long output", () => {
    expect(cleanSandyOutput("\x1b[0;31m[sandy]\x1b[0m --remove-sandbox: a live sandy session holds x.\n")).toBe("--remove-sandbox: a live sandy session holds x.");
    const long = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
    const out = cleanSandyOutput(long, 5).split("\n");
    expect(out).toHaveLength(6);
    expect(out[5]).toMatch(/35 more lines/);
  });
});
