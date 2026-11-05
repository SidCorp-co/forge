// The release's own record, read in the Technical view after the page (REQ-40): what stands in its
// way, the designs it ships approved, the feedback it answers, and its cuts, approvals and batch runs.
// Each is a section of the one page and an entry in its contents. They were a second tab strip under
// the page (Overview · Issues · Criteria · Checks · Notes) whose issues, criteria and notes repeated
// the page's own rows, and whose release train and requirement bars repeated the rail.

import type { ContentsItem } from "@/design";
import { ViewHeading } from "@/design";
import { useCopy } from "@/lib/i18n/interface-language";
import type { Copy } from "@/lib/i18n/product-copy";
import type { ReleaseDetail } from "../types";
import { GateLine } from "./release-bits";
import { ReleaseHistory } from "./release-checks";
import { ReleaseCorrections } from "./release-corrections";
import { FeedbackAnswered } from "./release-feedback";
import { ApprovedDesigns, DemoNotesWarning, NotesAttention } from "./release-note-reads";

const ANCHOR = {
  way: "release-way",
  designs: "release-designs",
  feedback: "release-feedback-answered",
  corrections: "release-corrections",
  history: "release-history",
} as const;

const hasHistory = (r: ReleaseDetail) => r.cuts.length + r.attempts.length + r.approvals.length > 0;
const wayTitle = (r: ReleaseDetail, t: Copy) => t(r.state === "draft" ? "releases.inTheWay" : "releases.worthKnowing");

/** The record's sections this release draws, as contents entries, in the order they are drawn. */
export function recordContents(r: ReleaseDetail, t: Copy): ContentsItem[] {
  return [
    ...(r.gates.length > 0 ? [{ id: ANCHOR.way, label: wayTitle(r, t) }] : []),
    ...(r.notes.designs.length > 0 ? [{ id: ANCHOR.designs, label: t("releases.designsApproved") }] : []),
    ...(r.feedbackAnswered.length > 0 ? [{ id: ANCHOR.feedback, label: t("releases.feedbackAnswered") }] : []),
    ...(r.corrections.length > 0 ? [{ id: ANCHOR.corrections, label: t("releases.corrections") }] : []),
    ...(hasHistory(r) ? [{ id: ANCHOR.history, label: t("releases.attempts") }] : []),
  ];
}

/**
 * Its tag on the source host (REQ-63 r7 BC-15), from the moment the commit its version names is known,
 * before any deploy: one word while the host is asked, the tag's own name where the host holds it,
 * else one word for why not. The sentence why is the record's (`release-tag-why`).
 */
export function ReleaseTagLine({ r }: { r: Pick<ReleaseDetail, "releasedAt" | "tag"> }) {
  const t = useCopy();
  const tag = r.tag ?? null;
  if (!tag && !r.releasedAt) return null;
  return (
    <p className="text-13 text-muted" data-testid="standing-tag">
      {t("releases.standing.label.tag")}{" "}
      {tag?.state === "tagged" ? (
        <span className="font-mono text-fg">{tag.name}</span>
      ) : (
        <span>{t(`releases.standing.tag.${tag?.state === "owed" ? "owed" : (tag?.code ?? "none")}`)}</span>
      )}
    </p>
  );
}

/**
 * What stands in the way reads the same gates the banner and the rail read, in the same words: the
 * gate the banner names is the first one here.
 */
export function ReleaseRecord({ r, slug }: { r: ReleaseDetail; slug: string }) {
  const t = useCopy();
  return (
    <div className="grid min-w-0 grid-cols-1 gap-8 pt-8" data-testid="release-record">
      <NotesAttention r={r} slug={slug} />
      {r.tag?.reason ? (
        <p className="break-words text-13 text-muted" data-testid="release-tag-why">
          {t("releases.tagWhy", { name: r.tag.name, reason: r.tag.reason })}
        </p>
      ) : null}
      <DemoNotesWarning r={r} />
      {r.gates.length > 0 ? (
        <section id={ANCHOR.way} aria-label={t("releases.whyNotCut")} className="scroll-mt-24" data-testid="release-way">
          <ViewHeading>{wayTitle(r, t)}</ViewHeading>
          <ul className="divide-y divide-line-subtle border-y border-line-subtle">
            {r.gates.map((g) => (
              <GateLine key={g.code} gate={g} slug={slug} />
            ))}
          </ul>
        </section>
      ) : null}
      <div id={ANCHOR.designs} className="scroll-mt-24 empty:hidden">
        <ApprovedDesigns r={r} slug={slug} />
      </div>
      <div id={ANCHOR.feedback} className="scroll-mt-24 empty:hidden">
        <FeedbackAnswered r={r} slug={slug} />
      </div>
      <div id={ANCHOR.corrections} className="scroll-mt-24 empty:hidden">
        <ReleaseCorrections r={r} slug={slug} />
      </div>
      {hasHistory(r) ? (
        <div id={ANCHOR.history} className="scroll-mt-24">
          <ReleaseHistory r={r} slug={slug} />
        </div>
      ) : null}
    </div>
  );
}
