"use client";

import { Card, CardContent, CardHeader, CardTitle, Markdown } from "@/design";
import type { WorkStep } from "@forge/contracts/issue-vocabulary";
import type { IssueDetail, IssueStatus } from "../types";

/** Built and not yet released — the only reading that earns the future-tense heading; anything else,
 *  an `in_progress` row with no known step included, gets the neutral heading, never a guess. */
export function builtNotReleased(status: IssueStatus, step: WorkStep | null | undefined): boolean {
  if (status === "awaiting_release") return true;
  return status === "in_progress" && step === "test";
}

function heading(status: IssueStatus, step: WorkStep | null | undefined): string {
  if (status === "closed") return "What changed";
  if (builtNotReleased(status, step)) return "What will change once it ships";
  return "Release note";
}

function sentence(status: IssueStatus, userFacing: string, skip: boolean): string {
  if (!skip) return userFacing;
  return status === "closed"
    ? "Nothing you would see changed — this work had no user-facing part."
    : "Nothing you would see changes — this work has no user-facing part.";
}

/** The release note, rendered as the markdown it is written in. A Reopened issue keeps its earlier
 *  note under "Release note" rather than calling shipped work a change still to come. */
export function ReleaseNoteCard({
  issue,
}: {
  issue: Pick<IssueDetail, "status" | "releaseNotes"> & { workState?: { step: WorkStep | null } | null };
}) {
  const note = issue.releaseNotes;
  if (!note || issue.status === "dropped") return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{heading(issue.status, issue.workState?.step)}</CardTitle>
      </CardHeader>
      <CardContent>
        <Markdown>{sentence(issue.status, note.userFacing, note.section === "Skip")}</Markdown>
      </CardContent>
    </Card>
  );
}
