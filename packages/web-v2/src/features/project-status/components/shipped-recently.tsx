"use client";

// The dashboard's first group (JU-3): what last reached people — the release, when, how many issues
// it carried, what was verified and the requirements now fully shipped — and the way to everything
// shipped in the window. Said plainly when nothing has shipped. Core's project status read.

import { PROJECT_STATUS_DAYS_DEFAULT, type StatusShipped } from "@forge/contracts/project-status";
import Link from "next/link";
import type { EtaClock } from "@/features/forecast/eta";
import { formatDateTime } from "@/lib/i18n/format";
import { useCopy } from "@/lib/i18n/interface-language";
import { releaseHref } from "@/lib/routes/releases";
import { statusReportHref } from "@/lib/routes/status";
import { verifiedSentence } from "@/features/releases/verified";

const LINK = "rounded-sm hover:underline focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]";

export function ShippedRecently({ shipped, slug, clock }: { shipped: StatusShipped | undefined; slug: string; clock: EtaClock }) {
  const t = useCopy();
  const last = shipped?.latest ?? null;
  return (
    <section aria-label={t("dash.shippedRecently")} data-testid="shipped-recently" className="border-b border-line-subtle pb-4">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <h2 className="text-16 font-bold text-accent-text">{t("dash.shippedRecently")}</h2>
        <Link href={statusReportHref(slug)} className={`text-13 text-link ${LINK}`} data-testid="shipped-recently-report">
          {t("dash.statusReport")}
        </Link>
      </div>
      {!shipped ? null : last ? (
        <div className="mt-2 grid gap-1">
          <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-13" data-testid="shipped-recently-last">
            <Link href={releaseHref(slug, last.version)} className={`font-mono text-16 font-semibold text-link ${LINK}`}>
              {last.version}
            </Link>
            <span className="text-muted">{formatDateTime(last.releasedAt, clock.lang, clock.timeZone)}</span>
            <span className="text-muted">{t("dash.shippedIssues", { n: last.issueCount })}</span>
            <span className="text-muted">{verifiedSentence(last.verified, t)}</span>
            {shipped.releases.length > 0 && shipped.requirementsShipped.length > 0 ? (
              <span className="text-muted">{t("dash.shippedCompletes", { keys: shipped.requirementsShipped.map((r) => r.key).join(", ") })}</span>
            ) : null}
          </p>
          {last.headline ? <p className="text-13">{last.headline}</p> : null}
          <Link href={statusReportHref(slug)} className={`text-13 text-link ${LINK}`}>
            {t("dash.shippedAll", { days: PROJECT_STATUS_DAYS_DEFAULT })}
          </Link>
        </div>
      ) : (
        <p className="mt-2 text-13 text-muted" data-testid="shipped-recently-none">
          {t("dash.shippedNone")}
        </p>
      )}
    </section>
  );
}
