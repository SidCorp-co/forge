"use client";

// The Dashboard's figures for a BA or PM, one flat row on a hairline: requirements by state,
// feedback open and aging, the next release and when it is in people's hands. Every figure links to
// the list it counts. Development's figures (runs, runners, spend, open issues) are not here.

import Link from "next/link";
import { EtaInline } from "@/features/forecast/components/eta-cell";
import type { Eta, EtaClock } from "@/features/forecast/eta";
import { feedbackListHref } from "@/lib/routes/feedback";
import { releaseHref, releasesListHref } from "@/lib/routes/releases";
import { requirementsHref } from "@/lib/routes/requirements";
import type { FeedbackFigures, requirementsByState } from "../ba-derive";
import { useCopy, useLabel } from "@/lib/i18n/interface-language";

const LINK = "rounded-sm hover:underline focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]";

function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <h3 className="text-12 font-semibold text-subtle">{label}</h3>
      <div className="mt-1 flex flex-wrap items-baseline gap-x-5 gap-y-1">{children}</div>
    </div>
  );
}

const Figure = ({ href, label, value, accent }: { href: string; label: string; value: number | string; accent?: boolean }) => (
  <Link href={href} className={`inline-flex items-baseline gap-1.5 ${LINK}`}>
    <span className={`text-20 font-semibold tabular-nums ${accent ? "text-[var(--accent-text)]" : "text-fg"}`}>{value}</span>
    <span className="text-13 text-muted">{label}</span>
  </Link>
);

export interface BaFiguresProps {
  slug: string;
  requirements: ReturnType<typeof requirementsByState>;
  feedback: FeedbackFigures;
  release: { version: string; eta: Eta | null } | null;
  clock: EtaClock;
}

export function BaFigures({ slug, requirements, feedback, release, clock }: BaFiguresProps) {
  const t = useCopy();
  const label = useLabel();
  return (
    <section
      aria-label={t("dash.progress")}
      data-testid="ba-figures"
      className="grid grid-cols-1 gap-x-10 gap-y-4 border-y border-line-subtle py-4 md:grid-cols-[minmax(0,2fr)_minmax(0,1.2fr)_minmax(0,1fr)]"
    >
      <Group label={t("dash.requirements")}>
        {requirements.map((r) => (
          <Figure key={r.state} href={`${requirementsHref(slug)}?group=status`} label={label("requirementState", r.state)} value={r.count} />
        ))}
      </Group>
      <Group label={t("dash.feedback")}>
        <Figure href={feedbackListHref(slug)} label={t("dash.fbOpen")} value={feedback.open} />
        <Figure href={feedbackListHref(slug)} label={t("dash.fbUntriaged")} value={feedback.untriaged} accent={feedback.untriaged > 0} />
        <Figure href={feedbackListHref(slug)} label={t("dash.fbAging")} value={feedback.aging} accent={feedback.aging > 0} />
      </Group>
      <Group label={t("dash.nextRelease")}>
        {release ? (
          <>
            <Link href={releaseHref(slug, release.version)} className={`font-mono text-16 font-semibold text-link ${LINK}`}>
              {release.version}
            </Link>
            {release.eta ? <EtaInline eta={release.eta} clock={clock} /> : null}
          </>
        ) : (
          <Link href={releasesListHref(slug)} className={`text-13 text-muted ${LINK}`}>
            {t("dash.nothingInPreparation")}
          </Link>
        )}
      </Group>
    </section>
  );
}
