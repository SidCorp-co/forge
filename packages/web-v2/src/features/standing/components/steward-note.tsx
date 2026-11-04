// The steward's note on a requirement, feedback or issue page (REQ-48 BC-7): its two lines above the
// properties, each record it cites linked where the line names it. A note the standing has moved past
// (`stale`, its basis no longer the standing's) is not drawn until the steward writes it again: it
// says what was true then, and ISS-643's, written before ISS-687 round 2, still named people who must
// answer under the Stuck banner. The standing's own banner says what is true now.

import type { StewardCite, StewardCiteKind, StewardNote } from "@forge/contracts/steward";
import { Link } from "@/lib/navigation/router";
import { useCopy } from "@/lib/i18n/interface-language";
import { feedbackHref } from "@/lib/routes/feedback";
import { issueHref } from "@/lib/routes/issues";
import { releaseHref } from "@/lib/routes/releases";
import { requirementHref } from "@/lib/routes/requirements";
import { workflowHref } from "@/lib/routes/workflows";
import { cn } from "@/lib/utils/cn";

/** Where a cited record lives; a cite with no page of its own (a verdict, a comment, a run) stays text. */
const CITE_HREF: Partial<Record<StewardCiteKind, (slug: string, ref: string) => string>> = {
  requirement: requirementHref,
  feedback: feedbackHref,
  issue: issueHref,
  release: releaseHref,
  workflow: workflowHref,
};

/** One line, each cite whose ref it names linked in place, in the order they appear. */
function NoteLine({ text, cites, slug }: { text: string; cites: readonly StewardCite[]; slug: string }) {
  const parts: React.ReactNode[] = [];
  let rest = text;
  for (;;) {
    const hits = cites
      .filter((c) => CITE_HREF[c.kind])
      .map((c) => ({ c, at: rest.indexOf(c.ref) }))
      .filter((h) => h.at >= 0)
      .sort((a, b) => a.at - b.at || b.c.ref.length - a.c.ref.length);
    const hit = hits[0];
    if (!hit) break;
    const href = CITE_HREF[hit.c.kind]?.(slug, hit.c.ref) ?? "";
    parts.push(rest.slice(0, hit.at));
    parts.push(
      <Link key={parts.length} href={href} className="whitespace-nowrap font-mono text-link hover:underline" data-testid="note-cite">
        {hit.c.ref}
      </Link>,
    );
    rest = rest.slice(hit.at + hit.c.ref.length);
  }
  parts.push(rest);
  return <p className="text-13">{parts}</p>;
}

export function StewardNoteLines({ note, slug, className }: { note: StewardNote | null; slug: string; className?: string }) {
  const t = useCopy();
  if (!note || note.stale) return null;
  const [first, second] = note.lines;
  return (
    <section aria-label={t("steward.note.label")} className={cn("flex flex-col gap-0.5 border-b border-line-divider py-2 text-fg", className)} data-testid="steward-note">
      {/* line 1 says what happened and what blocks; line 2, where written, what is next and by when */}
      {first ? <NoteLine text={first} cites={note.cites} slug={slug} /> : null}
      {second ? <NoteLine text={second} cites={note.cites} slug={slug} /> : null}
    </section>
  );
}
