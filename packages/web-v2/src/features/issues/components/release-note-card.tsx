"use client";

import { PageSection, PageSectionBody, PageSectionHeader, PageSectionTitle, Markdown } from "@/design";
import type { WorkStep } from "@forge/contracts/issue-vocabulary";
import { useCopy } from "@/lib/i18n/interface-language";
import type { Copy } from "@/lib/i18n/product-copy";
import type { IssueDetail, IssueStatus } from "../types";

/** Built and not yet released — the only reading that earns the future-tense heading; anything else,
 *  an `in_progress` row with no known step included, gets the neutral heading, never a guess. */
function builtNotReleased(status: IssueStatus, step: WorkStep | null | undefined): boolean {
  if (status === "awaiting_release") return true;
  return status === "in_progress" && step === "test";
}

function heading(status: IssueStatus, step: WorkStep | null | undefined, t: Copy): string {
  if (status === "closed") return t("issues.note.whatChanged");
  if (builtNotReleased(status, step)) return t("issues.note.willChange");
  return t("issues.note.title");
}

function sentence(status: IssueStatus, userFacing: string, skip: boolean, t: Copy): string {
  if (!skip) return userFacing;
  return status === "closed" ? t("issues.note.noneChanged") : t("issues.note.noneChanges");
}

/** The release note, rendered as the markdown it is written in. A Reopened issue keeps its earlier
 *  note under "Release note" rather than calling shipped work a change still to come. */
export function ReleaseNoteCard({
  issue,
}: {
  issue: Pick<IssueDetail, "status" | "releaseNotes"> & { workState?: { step: WorkStep | null } | null };
}) {
  const note = issue.releaseNotes;
  const t = useCopy();
  if (!note || issue.status === "dropped") return null;
  return (
    <PageSection>
      <PageSectionHeader>
        <PageSectionTitle>{heading(issue.status, issue.workState?.step, t)}</PageSectionTitle>
      </PageSectionHeader>
      <PageSectionBody>
        <Markdown>{sentence(issue.status, note.userFacing, note.section === "Skip", t)}</Markdown>
      </PageSectionBody>
    </PageSection>
  );
}
