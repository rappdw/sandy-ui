// Pure derivation for the "Sandy: Get Started" walkthrough's fix-it checks
// (rappdw/sandy-ui#31). Kept separate from extension.ts so the actual truth
// table is unit-testable without mocking vscode — extension.ts just resolves
// the two inputs (sandy_version from the cached schema, docker_reachable
// from the poller) and calls this.

export interface DoctorStatus {
  sandyOk: boolean;
  sandyVersion?: string;
  dockerOk: boolean;
}

export function deriveDoctorStatus(
  sandyVersion: string | undefined,
  dockerReachable: boolean | undefined,
): DoctorStatus {
  return {
    sandyOk: !!sandyVersion,
    sandyVersion,
    // Strict === true: undefined (never polled yet) and false (poller says
    // unreachable) both read as "not ok" — only a confirmed-reachable poll
    // result should tick the walkthrough step.
    dockerOk: dockerReachable === true,
  };
}
