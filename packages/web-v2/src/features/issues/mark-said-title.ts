// ISS-1017 — who marked the work, and what the repository read of a commit the mark names. The mark
// is the agent's word, so the rail says whose on the date's hover, adding no visible text.

import type { Copy } from "@/lib/i18n/product-copy";
import type { CommitReadingOutcome, MarkSaidRecord } from "./types";

const READING_KEY = {
  found: "issues.merge.reading.found",
  not_found: "issues.merge.reading.not_found",
  not_on_target: "issues.merge.reading.not_on_target",
  not_this_issue: "issues.merge.reading.not_this_issue",
  unread: "issues.merge.reading.unread",
} as const satisfies Record<CommitReadingOutcome, string>;

/** The hover on a mark's date: who said it, then the repository's reading where one was taken. */
export function markSaidTitle(t: Copy, said: MarkSaidRecord | null | undefined): string | undefined {
  if (!said) return undefined;
  const name = said.by.name ?? t(said.by.agency === "agent" ? "issues.merge.anAgent" : "issues.merge.aPerson");
  const lines = [t("issues.merge.saidBy", { name })];
  const reading = said.commitReading;
  if (reading) lines.push(t(READING_KEY[reading.outcome], { branch: reading.branch ?? "" }));
  return lines.join("\n");
}
