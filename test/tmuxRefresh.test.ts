import { describe, it, expect } from "vitest";
import { tmuxRefreshArgs } from "../src/terminal/tmuxRefresh";

// sandy-ui#55: a repaint must not resize any pane, so it asks tmux to redraw
// through `sandy --exec` instead of toggling the pty size.
describe("tmuxRefreshArgs", () => {
  it("puts --exec first (sandy only recognizes it as $1) and passes the command after --", () => {
    expect(tmuxRefreshArgs("/Users/x/dev/my proj")).toEqual(
      ["--exec", "--workspace", "/Users/x/dev/my proj", "--", "tmux", "refresh-client"]);
  });
});
