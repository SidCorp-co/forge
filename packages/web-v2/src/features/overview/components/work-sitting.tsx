"use client";

import Link from "next/link";
import {
  PageSection,
  PageSectionBody,
  PageSectionTitle,
  DotStrip,
  SectionTitle,
  Waffle,
} from "@/design";
import { useCopy } from "@/lib/i18n/interface-language";
import { bucketHref, formatElapsed, projectSilenceRows, waffleCells } from "../derive";
import { BUCKET_ORDER } from "../derive";
import type { PulseResponse } from "../types";

export interface WorkSittingProps {
  pulse: PulseResponse;
  nowMs: number;
}

/** Section 2 — where is the work sitting? */
export function WorkSitting({ pulse, nowMs }: WorkSittingProps) {
  const t = useCopy();
  const cells = waffleCells(pulse.work.buckets, t);
  const rows = projectSilenceRows(pulse, nowMs);
  const ages = pulse.work.humanBlockedAges;

  return (
    <PageSection>
      <PageSectionBody className="flex flex-col gap-4">
        <SectionTitle className="fg-h3">{t("overview.sitting.title")}</SectionTitle>

        {cells.some((c) => c.count > 0) ? (
          <Waffle
            categories={cells.map((c) => ({
              key: c.key,
              label: c.label,
              count: c.count,
              color: c.color,
              onOpen: () => {
                document
                  .getElementById("pulse-per-project")
                  ?.scrollIntoView({ behavior: "smooth", block: "start" });
              },
            }))}
          />
        ) : (
          <p className="fg-body-sm text-muted">{t("overview.sitting.empty")}</p>
        )}

        {ages.length > 0 ? (
          <div className="flex flex-col gap-1">
            <PageSectionTitle className="fg-body-sm text-muted">
              {t(ages.length === 1 ? "overview.sitting.blockedOne" : "overview.sitting.blockedMany", { n: ages.length, age: formatElapsed(Math.max(...ages), t) })}
            </PageSectionTitle>
            <DotStrip
              items={ages.map((age, i) => ({
                key: `age-${i}`,
                value: age,
                label: t("overview.sitting.waiting", { age: formatElapsed(age, t) }),
              }))}
              axisLabels={[t("overview.sitting.justBlocked"), t("overview.sitting.ageWaiting", { age: formatElapsed(Math.max(...ages), t) })]}
            />
          </div>
        ) : null}

        <div id="pulse-per-project" className="flex flex-col gap-2">
          <PageSectionTitle className="fg-body-sm text-muted">{t("overview.sitting.longest")}</PageSectionTitle>
          {rows.length === 0 ? (
            <p className="fg-body-sm text-muted">{t("overview.sitting.noProjects")}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[32rem]">
                <thead>
                  <tr className="fg-body-sm text-subtle">
                    <th scope="col" className="py-1 text-left font-normal">{t("overview.sitting.project")}</th>
                    {BUCKET_ORDER.map((b) => (
                      <th key={b} scope="col" className="py-1 text-right font-normal">
                        {t(`overview.bucket.${b}`)}
                      </th>
                    ))}
                    <th scope="col" className="py-1 text-right font-normal">{t("overview.sitting.lastRun")}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id} className="fg-body-sm border-t border-line-subtle">
                      <td className="py-1 text-left">
                        <Link
                          href={`/projects/${r.slug}`}
                          className="rounded-sm px-1 hover:bg-hover focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
                        >
                          {r.name}
                        </Link>
                      </td>
                      {BUCKET_ORDER.map((b) => (
                        <td key={b} className="py-1 text-right tabular-nums">
                          {r.buckets[b] === 0 ? (
                            <span className="text-disabled">0</span>
                          ) : (
                            <Link
                              href={bucketHref(r.slug, b)}
                              aria-label={t("overview.sitting.cellAria", { name: r.name, n: r.buckets[b], bucket: t(`overview.bucket.${b}`) })}
                              className="rounded-sm px-1 hover:bg-hover focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
                            >
                              {r.buckets[b]}
                            </Link>
                          )}
                        </td>
                      ))}
                      <td className="py-1 text-right tabular-nums text-muted">
                        {r.neverRan ? t("overview.neverRan") : formatElapsed(r.silenceSeconds, t)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </PageSectionBody>
    </PageSection>
  );
}
