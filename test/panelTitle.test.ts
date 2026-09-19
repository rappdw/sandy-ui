import { describe, it, expect } from "vitest";
import { panelTitle, workspaceLabel, TitleState } from "../src/terminal/panelTitle";

// The tab title is also the leading text of the OS window title, and macOS
// sorts its Window menu by that string. Everything here is really one
// assertion: the workspace name comes first, always, whatever else happens.
describe("panelTitle", () => {
  const ws = "/Users/x/dev/amap-lab";

  it("leads with the workspace name for every state", () => {
    const states: TitleState[] = [
      { kind: "starting" },
      { kind: "attached" },
      { kind: "detached" },
      { kind: "exited", code: 3 },
      { kind: "app", title: "claude" },
    ];
    for (const s of states) {
      expect(panelTitle(ws, s).startsWith("amap-lab · ")).toBe(true);
    }
  });

  it("renders the states distinguishably", () => {
    expect(panelTitle(ws, { kind: "starting" })).toBe("amap-lab · Sandy (starting…)");
    expect(panelTitle(ws, { kind: "attached" })).toBe("amap-lab · Sandy");
    expect(panelTitle(ws, { kind: "detached" })).toBe("amap-lab · Sandy (detached)");
    expect(panelTitle(ws, { kind: "exited", code: 6 })).toBe("amap-lab · Sandy (exit 6)");
  });

  it("carries no pid — the pid is what made the window menu sort useless", () => {
    for (const t of [
      panelTitle(ws, { kind: "attached" }),
      panelTitle(ws, { kind: "starting" }),
      panelTitle(ws, { kind: "detached" }),
    ]) {
      expect(t.toLowerCase()).not.toContain("pid");
    }
  });

  it("keeps an app (OSC-0) title as a detail, never replacing the workspace", () => {
    const t = panelTitle(ws, { kind: "app", title: "spark-bf5a: sandy" });
    expect(t).toBe("amap-lab · spark-bf5a: sandy");
    expect(t.startsWith("amap-lab · ")).toBe(true);
  });

  it("puts the activity bullet AFTER the workspace so busy windows still sort by name", () => {
    const t = panelTitle(ws, { kind: "attached" }, true);
    expect(t).toBe("amap-lab · ● Sandy");
    expect(t.startsWith("●")).toBe(false);
  });

  it("sorts a realistic set of windows by workspace, not by pid", () => {
    // Mirrors the reported symptom: pids ascending, workspaces scrambled.
    const windows: Array<[string, number]> = [
      ["/w/sandy-ui", 72933],
      ["/w/amap-lab", 10263],
      ["/w/rapphaus-network", 65965],
      ["/w/amap-spec", 54606],
    ];
    const titles = windows.map(([w]) => panelTitle(w, { kind: "attached" })).sort();
    expect(titles).toEqual([
      "amap-lab · Sandy",
      "amap-spec · Sandy",
      "rapphaus-network · Sandy",
      "sandy-ui · Sandy",
    ]);
  });

  it("degrades sanely with no workspace", () => {
    expect(panelTitle(undefined, { kind: "attached" })).toBe("(no workspace) · Sandy");
    expect(workspaceLabel("")).toBe("(no workspace)");
    expect(workspaceLabel("/w/proj/")).toBe("proj");   // trailing slash
  });
});
