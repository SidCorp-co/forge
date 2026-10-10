"use client";

import Link from "next/link";
import {
  PageSection,
  PageSectionBody,
  PageSectionTitle,
  DotStrip,
  SectionTitle,
  Waffle, Table, THead, TBody, TR, TH, TD } from "@/design";
import { useCopy } from "@/lib/i18n/interface-language";
import { bucketHref, formatElapsed, projectSilenceRows, waffleCells } from "../derive";
import { BUCKET_ORDER } from "../derive";
import type { PulseResponse } from "../types";

interface WorkSittingProps {
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
              <Table className="w-full min-w-128">
                <THead>
                  <TR className="fg-body-sm text-subtle">
                    <TH scope="col" className="py-1 text-left font-normal">{t("overview.sitting.project")}</TH>
                    {BUCKET_ORDER.map((b) => (
                      <TH key={b} scope="col" className="py-1 text-right font-normal">
                        {t(`overview.bucket.${b}`)}
                      </TH>
                    ))}
                    <TH scope="col" className="py-1 text-right font-normal">{t("overview.sitting.lastRun")}</TH>
                  </TR>
                </THead>
                <TBody>
                  {rows.map((r) => (
                    <TR key={r.id} className="fg-body-sm border-t border-line-subtle">
                      <TD className="py-1 text-left">
                        <Link
                          href={`/projects/${r.slug}`}
                          className="rounded-sm px-1 hover:bg-hover focus-visible:outline-none focus-visible:shadow-focus"
                        >
                          {r.name}
                        </Link>
                      </TD>
                      {BUCKET_ORDER.map((b) => (
                        <TD key={b} className="py-1 text-right tabular-nums">
                          {r.buckets[b] === 0 ? (
                            <span className="text-disabled">0</span>
                          ) : (
                            <Link
                              href={bucketHref(r.slug, b)}
                              aria-label={t("overview.sitting.cellAria", { name: r.name, n: r.buckets[b], bucket: t(`overview.bucket.${b}`) })}
                              className="rounded-sm px-1 hover:bg-hover focus-visible:outline-none focus-visible:shadow-focus"
                            >
                              {r.buckets[b]}
                            </Link>
                          )}
                        </TD>
                      ))}
                      <TD className="py-1 text-right tabular-nums text-muted">
                        {r.neverRan ? t("overview.neverRan") : formatElapsed(r.silenceSeconds, t)}
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </div>
          )}
        </div>
      </PageSectionBody>
    </PageSection>
  );
}
