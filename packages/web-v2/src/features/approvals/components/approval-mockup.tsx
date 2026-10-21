// A mockup decision on the Approvals page (REQ-49 BC-7): the mockup itself, run in place, its round and
// what it revises and the comments still open on it. What accepting does is core's consequence line,
// read under "If you approve"; Accept and Return are the peek's own acts; full screen opens it on its
// item's page, where it is commented on.

import type { NeedsYouDecision } from "@forge/contracts/needs-you-decisions";
import { MockupPreview, MockupThumb } from "@/features/mockups";
import { useCopy } from "@/lib/i18n/interface-language";
import { Link } from "@/lib/navigation/router";

type MockupFacts = NonNullable<NeedsYouDecision["mockup"]>;

/** Its round and what it revises, and its open comments, in one line. */
export function MockupStanding({ m }: { m: MockupFacts }) {
  const t = useCopy();
  const facts = [
    m.revises ? t("common.mockups.revisesLine", { n: m.round, key: m.revises }) : t("common.mockups.round", { n: m.round }),
    m.openComments ? t("common.mockups.openComments", { n: m.openComments }) : null,
  ].filter(Boolean);
  return (
    <span className="text-12 text-muted" data-testid="approval-mockup-standing">
      {facts.join(" · ")}
    </span>
  );
}

/** The mockup small, beside the row's acts. */
export function RowMockup({ d }: { d: NeedsYouDecision }) {
  if (!d.mockup) return null;
  return (
    <div className="max-sm:hidden" data-testid="approval-row-mockup">
      <MockupThumb url={d.mockup.url} kind={d.mockup.kind} name={d.mockup.name} />
    </div>
  );
}

/** The mockup in the peek: run in place, where it stands, and full screen on its item. */
export function PeekMockup({ d, itemHref }: { d: NeedsYouDecision; itemHref: string }) {
  const t = useCopy();
  if (!d.mockup) return null;
  const m = d.mockup;
  // the item's page opens it full screen from its address, as its own row does
  const full = `${itemHref}${itemHref.includes("?") ? "&" : "?"}mockup=${encodeURIComponent(m.key)}&full=1`;
  return (
    <section className="flex flex-col gap-2" data-testid="approval-peek-mockup">
      <MockupPreview url={m.url} kind={m.kind} name={m.name} className="h-80" />
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <MockupStanding m={m} />
        <Link href={full} className="ml-auto text-13 font-semibold text-fg hover:underline" data-testid="approval-peek-mockup-full">
          {t("common.mockups.fullScreen")}
        </Link>
      </div>
    </section>
  );
}
