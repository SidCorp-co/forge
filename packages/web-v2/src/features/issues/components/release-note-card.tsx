"use client";

import { Card, CardContent, CardHeader, CardTitle, Markdown } from "@/design";
import type { IssueDetail, IssueStatus } from "../types";

/* status-tuple: differs — the statuses where the work is built and not yet released, which is the
   one reading that lets this card speak of the change in the future tense. It is a heading choice,
   not a lifecycle set, and a status outside it falls to the neutral heading rather than a guess. */
export const BUILT_NOT_RELEASED: ReadonlySet<IssueStatus> = new Set<IssueStatus>([
  "developed",
  "testing",
  "tested",
  "awaiting_release",
  "releasing",
]);

function heading(status: IssueStatus): string {
  if (status === "closed") return "What changed";
  if (BUILT_NOT_RELEASED.has(status)) return "What will change once it ships";
  return "Release note";
}

function sentence(status: IssueStatus, userFacing: string, skip: boolean): string {
  if (!skip) return userFacing;
  return status === "closed"
    ? "Nothing you would see changed — this work had no user-facing part."
    : "Nothing you would see changes — this work has no user-facing part.";
}

/**
 * The release note's plain-language line, on the issue page of the person who filed the work,
 * rendered as the markdown it is written in so its markup never shows as characters. The heading
 * says only what the status establishes: a Reopened issue keeps its earlier note under "Release
 * note" instead of calling work that already shipped a change still to come.
 */
export function ReleaseNoteCard({ issue }: { issue: Pick<IssueDetail, "status" | "releaseNotes"> }) {
  const note = issue.releaseNotes;
  if (!note || issue.status === "dropped") return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{heading(issue.status)}</CardTitle>
      </CardHeader>
      <CardContent>
        <Markdown>{sentence(issue.status, note.userFacing, note.section === "Skip")}</Markdown>
      </CardContent>
    </Card>
  );
}
