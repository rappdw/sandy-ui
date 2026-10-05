import { describe, it, expect } from "vitest";
import { parsePrintVersion, scrapeVersion, identityKey } from "../src/schema/cache";

// sandy-ui#44: the schema cache was keyed on a regex scraped from
// `sandy --version`. It now keys on `--print-version` (machine-readable, 1.7.0+)
// plus the binary's mtime/size, because main-HEAD installs share one version
// string and curl installs report an empty commit.
describe("schema cache identity", () => {
  it("parses --print-version, preferring full_version for the key", () => {
    expect(parsePrintVersion('{"schema_version":4,"version":"2.8.0-dev","commit":"abc1234","full_version":"2.8.0-dev+abc1234"}'))
      .toEqual({ version: "2.8.0-dev", fullVersion: "2.8.0-dev+abc1234" });
  });
  it("falls back to version when full_version is empty (curl installs report no commit)", () => {
    expect(parsePrintVersion('{"schema_version":4,"version":"2.7.1","commit":"","full_version":""}'))
      .toEqual({ version: "2.7.1", fullVersion: "2.7.1" });
  });
  it("rejects output that isn't a version document", () => {
    expect(parsePrintVersion("sandy 2.7.1")).toBeUndefined();
    expect(parsePrintVersion('{"version":""}')).toBeUndefined();
  });
  it("scrapes --version as a last resort", () => {
    expect(scrapeVersion("sandy 2.7.1\n")).toBe("2.7.1");
    expect(scrapeVersion("no version here")).toBeUndefined();
  });
  it("changes the key when the same version is reinstalled", () => {
    const a = identityKey("2.8.0-dev", { mtimeMs: 1000.7, size: 100 });
    expect(a).toBe("2.8.0-dev|1000|100");
    expect(identityKey("2.8.0-dev", { mtimeMs: 2000, size: 100 })).not.toBe(a);
    expect(identityKey("2.8.0-dev", { mtimeMs: 1000, size: 101 })).not.toBe(a);
    expect(identityKey("2.8.0-dev", undefined)).toBe("2.8.0-dev");
  });
});
