"use client";

// What the issue changes for a reader, as one line: the release note's first line, and the release
// that shipped it. The developer view draws the whole note.

import Link from "next/link";
import { Markdown } from "@/design";
import { useCopy } from "@/lib/i18n/interface-language";
import { releaseHref } from "@/lib/routes/releases";
import type { IssueDetail } from "../types";

/** The first line of a markdown note as plain text: no heading, list or emphasis marks. */
export function firstLine(markdown: string): string {
  const line = markdown.split("\n").find((l) => l.trim() !== "") ?? "";
  return line
    .replace(/^\s*(#{1,6}|[-*+]|\d+[.)])\s+/, "")
    .replace(/[*_`]/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .trim();
}

export function ChangesRow({ issue, slug, developer }: { issue: Pick<IssueDetail, "status" | "releaseNotes" | "shippedIn">; slug: string; developer: boolean }) {
  const t = useCopy();
  const note = issue.releaseNotes;
  if (issue.status === "dropped" || (!note && !issue.shippedIn)) return null;
  const none = !note || note.section === "Skip" || note.userFacing.trim() === "";
  return (
    <section aria-label={t("issues.changes.title")} data-testid="issue-changes" className="grid gap-2 border-b border-line-subtle py-4">
      <div className="flex min-w-0 items-baseline gap-3">
        <h2 className="w-21 flex-none text-12 font-medium uppercase tracking-wide text-subtle">{t("issues.changes.title")}</h2>
        <span className="min-w-0 flex-1 truncate text-14" title={none ? undefined : firstLine(note?.userFacing ?? "")}>
          {none ? <span className="text-muted">{t("issues.now.none")}</span> : firstLine(note?.userFacing ?? "")}
        </span>
        {issue.shippedIn ? (
          <Link href={releaseHref(slug, issue.shippedIn.version)} className="flex-none font-mono text-12 text-link hover:underline" data-testid="rail-shipped-in">
            {issue.shippedIn.version}
          </Link>
        ) : null}
      </div>
      {developer && !none && note ? <Markdown>{note.userFacing}</Markdown> : null}
    </section>
  );
}
