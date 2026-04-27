import * as vscode from "vscode";
import { HEADER, SUBTEXT, HOSTILE_KEYVALUES } from "./sample";

export async function showApprovalNative(): Promise<"approve" | "reject" | undefined> {
  // Concatenate subtext + raw KEY=VALUE block into the `detail` field.
  // VSCode's API docs do not specify whether `detail` preserves whitespace,
  // line breaks, or special chars — that's exactly what this spike measures.
  const detail = `${SUBTEXT}\n\n${HOSTILE_KEYVALUES}`;
  const choice = await vscode.window.showInformationMessage(
    HEADER,
    { modal: true, detail },
    "Approve",
    "Reject"
  );
  return choice === "Approve" ? "approve" : choice === "Reject" ? "reject" : undefined;
}
