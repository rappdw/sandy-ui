// Deleting a sandbox goes through `sandy --remove-sandbox` (sandy #178). It
// used to be an `rm -rf` of ~/.sandy/sandboxes/<name> here, which read sandy's
// private host layout (its path contract, 2.7 #386, says that may change in any
// release) and left behind what sandy keeps next to the directory: the sibling
// .claude.json, feature records, the lock. sandy also refuses while a live
// session or container holds the sandbox. Pure helpers only; extension.ts runs it.

/** The names sandy accepts for `--sandbox` (its _rms_validate_sandbox_name). */
export function isValidSandboxName(name: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(name) && !name.startsWith(".") && !name.includes("..");
}

export function removeSandboxArgs(name: string, dryRun: boolean): string[] {
  return ["--remove-sandbox", "--sandbox", name, dryRun ? "--dry-run" : "--yes"];
}

/** sandy's output, minus colour codes and its `[sandy] ` prefix, trimmed to `maxLines`. */
export function cleanSandyOutput(text: string, maxLines = 30): string {
  const lines = text
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")
    .split("\n")
    .map(l => l.replace(/^\[sandy\]\s?/, "").trimEnd())
    .filter((l, i, all) => l !== "" || (i > 0 && all[i - 1] !== ""));
  while (lines.length && lines[0] === "") lines.shift();
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  if (lines.length <= maxLines) return lines.join("\n");
  return [...lines.slice(0, maxLines), `… (${lines.length - maxLines} more lines in the "Sandy State" output)`].join("\n");
}

/** The dry run's plan for the confirmation dialog, without its "nothing removed" footer. */
export function removalPlan(dryRunOutput: string): string {
  return cleanSandyOutput(dryRunOutput.split("\n").filter(l => !/--dry-run: nothing removed/.test(l)).join("\n"));
}
