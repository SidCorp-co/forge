// `CLAIM_CONFLICT` in a person's words, composed from the standings the refusal carries. Core's own
// sentence names the API routes an agent reads a run by; the page that pressed Release now offers
// none of them (ISS-1381 r4).

import { ISSUE_STATUS_LABELS } from "@forge/contracts/issue-vocabulary";

type Standing =
  | { key: string; standing: "claimed"; runEnded: boolean; status: string }
  | { key: string; standing: "status"; status: string }
  | { key: string; standing: "absent" };

function standingsIn(details: unknown): Standing[] | null {
  const conflicts = (details as { conflicts?: unknown } | null)?.conflicts;
  if (!Array.isArray(conflicts) || conflicts.length === 0) return null;
  const read = conflicts.filter(
    (c): c is Standing =>
      typeof c === "object" &&
      c !== null &&
      typeof (c as Standing).key === "string" &&
      ["claimed", "status", "absent"].includes((c as Standing).standing),
  );
  return read.length === conflicts.length ? read : null;
}

function label(status: string): string {
  return (ISSUE_STATUS_LABELS as Record<string, string>)[status] ?? status;
}

function sentenceFor(c: Standing): string {
  if (c.standing === "absent") return `${c.key} is no issue on this project.`;
  if (c.standing === "status") {
    if (c.status === "closed") return `${c.key} is Closed: it has shipped, and a release carries an issue once.`;
    if (c.status === "dropped") return `${c.key} is Dropped, so no release carries it.`;
    return `${c.key} is ${label(c.status)}, not at the release gate.`;
  }
  if (!c.runEnded) {
    return `${c.key} is already in a release that is still running; it comes free once that release ends.`;
  }
  if (c.status === "releasing") {
    return `${c.key} is still held by a release that has ended, and nothing on this page releases that hold: whoever operates Forge aborts that release, which puts it back at the release gate.`;
  }
  return `${c.key} is still marked as in a release that has ended; that mark clears within a minute, so press again then.`;
}

/** The refusal's sentence, or `null` where it carries no standings to compose one from. */
export function claimConflictSentence(details: unknown): string | null {
  const standings = standingsIn(details);
  if (!standings) return null;
  return `No release was started. ${standings.map(sentenceFor).join(" ")}`;
}
