"use client";

// "Since last report": what changed between a kept report and the one before it, every line core
// derived from the two stored reports (`@forge/contracts/status-reports:statusReportDiff`). Flat:
// one heading per kind of change over hairline lists, an empty part said in one quiet line.

import type { StatusReportDetail } from "@forge/contracts/status-reports";
import Link from "next/link";
import type { ReactNode } from "react";
import { MonoTag, ViewHeading } from "@/design";
import type { EtaClock } from "@/features/forecast/eta";
import { spanText } from "@/features/forecast/text";
import { needsYouHref, needsYouKeyLabel } from "@/features/needs-you/routes";
import { formatDateTime } from "@/lib/i18n/format";
import { useCopy, useLabel } from "@/lib/i18n/interface-language";
import { issueHref } from "@/lib/routes/issues";
import { releaseHref } from "@/lib/routes/releases";
import { requirementHref } from "@/lib/routes/requirements";

const ROW = "flex flex-wrap items-baseline gap-x-3 gap-y-0.5 border-b border-line-subtle py-2 text-13";
const KEY_LINK = "font-mono text-12 text-link hover:underline";

function Part({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  const t = useCopy();
  return (
    <div className="grid gap-1.5" data-testid="since-part">
      <h3 className="text-13 font-semibold text-fg">
        {title} <span className="font-normal text-muted">{count}</span>
      </h3>
      {count === 0 ? <p className="text-13 text-muted">{t("status.since.nothing")}</p> : <ul className="border-t border-line-subtle">{children}</ul>}
    </div>
  );
}

export function SinceLastReport({ detail, slug, clock }: { detail: StatusReportDetail; slug: string; clock: EtaClock }) {
  const t = useCopy();
  const label = useLabel();
  const when = (iso: string) => formatDateTime(iso, clock.lang, clock.timeZone);
  const d = detail.diff;
  return (
    <section aria-label={t("status.since.title")} data-testid="status-since" className="grid gap-4">
      <ViewHeading hint={d ? t("status.since.at", { at: when(d.since) }) : undefined}>{t("status.since.title")}</ViewHeading>
      {d === null ? (
        <p className="text-13 text-muted">{t("status.since.first")}</p>
      ) : (
        <div className="grid gap-5">
          <Part title={t("status.since.shipped")} count={d.shipped.length + d.requirementsShipped.length}>
            {d.shipped.map((r) => (
              <li key={r.version} className={ROW} data-testid="since-shipped">
                <Link href={releaseHref(slug, r.version)} className="font-mono text-13 font-semibold text-link hover:underline">
                  {r.version}
                </Link>
                <span className="text-muted">{when(r.releasedAt)}</span>
                <span className="w-full text-12-5">
                  {r.issues.map((i, at) => (
                    <span key={i.key}>
                      {at > 0 ? ", " : ""}
                      <Link href={issueHref(slug, i.key)} className={KEY_LINK} title={i.title}>
                        {i.key}
                      </Link>
                    </span>
                  ))}
                </span>
              </li>
            ))}
            {d.requirementsShipped.map((r) => (
              <li key={r.key} className={ROW}>
                <Link href={requirementHref(slug, r.key)} className={KEY_LINK}>
                  {r.key}
                </Link>
                <span className="min-w-0 flex-1">{r.title}</span>
                <span className="text-12-5 text-muted">{t("status.requirementsShipped")}</span>
              </li>
            ))}
          </Part>
          <Part title={t("status.since.late")} count={d.newlyLate.length}>
            {d.newlyLate.map((l) => (
              <li key={`${l.kind}:${l.key}`} className={ROW}>
                <MonoTag>{l.key}</MonoTag>
                <span className="min-w-0 flex-1">{l.title}</span>
                <span className="text-12-5 text-danger">{t(`status.late.${l.late.reason}`, { by: spanText(l.late.byMinutes, clock.lang) })}</span>
              </li>
            ))}
          </Part>
          <Part title={t("status.since.cleared")} count={d.noLongerWaiting.length}>
            {d.noLongerWaiting.map((x) => (
              <li key={`${x.area}:${x.key}`} className={ROW}>
                <Link href={needsYouHref(slug, x)} className={KEY_LINK}>
                  {needsYouKeyLabel(x, (a) => label("needsYouArea", a))}
                </Link>
                <span className="min-w-0 flex-1">{x.title}</span>
              </li>
            ))}
          </Part>
          {d.waitsCut ? <p className="text-12-5 text-muted">{t("status.since.waitsCut", { n: detail.status?.waits.people.length ?? 0 })}</p> : null}
          <Part title={t("status.since.moved")} count={d.moved.length}>
            {d.moved.map((m) => (
              <li key={`${m.kind}:${m.key}`} className={ROW} data-testid="since-moved">
                {m.kind === "release" ? (
                  <Link href={releaseHref(slug, m.key)} className="font-mono text-13 font-semibold text-link hover:underline">
                    {m.title}
                  </Link>
                ) : (
                  <>
                    <Link href={requirementHref(slug, m.key)} className={KEY_LINK}>
                      {m.key}
                    </Link>
                    <span className="min-w-0 flex-1">{m.title}</span>
                  </>
                )}
                <span className="text-12-5 text-muted">{t("status.since.movedLine", { from: when(m.from), to: when(m.to) })}</span>
              </li>
            ))}
          </Part>
        </div>
      )}
    </section>
  );
}
