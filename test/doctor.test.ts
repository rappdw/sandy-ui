import { describe, it, expect } from "vitest";
import { deriveDoctorStatus } from "../src/doctor";

describe("deriveDoctorStatus", () => {
  it("sandy present, docker reachable — both ok", () => {
    expect(deriveDoctorStatus("1.2.0", true)).toEqual({
      sandyOk: true,
      sandyVersion: "1.2.0",
      dockerOk: true,
    });
  });

  it("sandy present, docker unreachable", () => {
    expect(deriveDoctorStatus("1.2.0", false)).toEqual({
      sandyOk: true,
      sandyVersion: "1.2.0",
      dockerOk: false,
    });
  });

  it("sandy present, docker reachability unknown (undefined) — not ok", () => {
    expect(deriveDoctorStatus("1.2.0", undefined)).toEqual({
      sandyOk: true,
      sandyVersion: "1.2.0",
      dockerOk: false,
    });
  });

  it("sandy absent, docker reachable — sandyOk false regardless of docker", () => {
    expect(deriveDoctorStatus(undefined, true)).toEqual({
      sandyOk: false,
      sandyVersion: undefined,
      dockerOk: true,
    });
  });

  it("sandy absent, docker unreachable — both not ok", () => {
    expect(deriveDoctorStatus(undefined, false)).toEqual({
      sandyOk: false,
      sandyVersion: undefined,
      dockerOk: false,
    });
  });

  it("sandy absent, docker reachability unknown — both not ok", () => {
    expect(deriveDoctorStatus(undefined, undefined)).toEqual({
      sandyOk: false,
      sandyVersion: undefined,
      dockerOk: false,
    });
  });

  it("empty-string version is falsy — treated as absent", () => {
    expect(deriveDoctorStatus("", true).sandyOk).toBe(false);
  });
});
