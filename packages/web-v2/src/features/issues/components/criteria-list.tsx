"use client";

// ISS-55 — the issue's acceptance criteria, flat: one row per criterion with its verdict badge.
// The identity, reason, author and time sit behind the badge's tooltip, not on the row. A person who
// may write records a verdict from the row, and ties the issue to its requirement's criteria from
// the heading. Below them, the criteria a reword or a re-tie retired, each marked Retired with every
// verdict it earned, so an earlier judge's finding stays readable (ISS-489).

import type { ReactNode } from "react";
import { EmptyPanelLine, StatusBadge, statusReading, Tooltip, ViewHeading } from "@/design";
import { formatApiError } from "@/lib/api/error";
import { useCopy, useInterfaceLanguage, useTimeFormat } from "@/lib/i18n/interface-language";
import type { Copy } from "@/lib/i18n/product-copy";
import { criterionStandingOf } from "@forge/contracts/verdict-identity";
import { identityPhrase } from "../identity-phrase";
import { type CriterionRow, type CriterionVerdict, type RetiredCriterionRow, useCriteria } from "../criteria";
import { RecordVerdict } from "./criteria-acts";

function tooltipOf(row: CriterionRow, t: Copy, language: string, at: (iso: string) => string): string {
  const v = row.latest;
  if (!v) return t("issues.verdict.none");
  return verdictLines(v, t, language, at);
}

function verdictLines(v: CriterionVerdict, t: Copy, language: string, at: (iso: string) => string): string {
  const by = v.authorAgency === "agent" ? t("issues.verdict.byAgent") : t("issues.verdict.byPerson");
  const parts = [
    `${v.verdict === "short" ? t("issues.verdict.short") : statusReading("criterion", v.verdict, language).label} · ${identityPhrase(v, t)}`,
    v.reason ? t("issues.verdict.reason", { reason: v.reason }) : null,
    t("issues.verdict.by", { by, at: at(v.createdAt) }),
  ];
  return parts.filter(Boolean).join("\n");
}

export function CriteriaList({
  issueId,
  judge,
  headingAct,
}: {
  issueId: string;
  /** Whether the reader may record a verdict; the Judge reads the build it defaults to from core. */
  judge?: boolean;
  headingAct?: ReactNode;
}) {
  const q = useCriteria(issueId);
  const t = useCopy();
  const language = useInterfaceLanguage();
  const time = useTimeFormat();
  if (q.isLoading) return <EmptyPanelLine title={t("issues.criteria.acceptance")} status={t("issues.steps.loading")} />;
  if (q.isError) {
    return (
      <EmptyPanelLine title={t("issues.criteria.acceptance")} status={t("common.couldNotLoad")} detail={formatApiError(q.error)} />
    );
  }
  const rows = q.data?.criteria ?? [];
  const retired = q.data?.retired ?? [];
  if (rows.length === 0 && retired.length === 0) return null;
  return (
    <section aria-label={t("issues.criteria.acceptance")}>
      <ViewHeading right={headingAct}>{t("issues.criteria.acceptance")}</ViewHeading>
      <ol className="divide-y divide-line-subtle">
        {rows.map((row) => {
          return (
            <li key={row.id} className="flex items-start gap-3 py-2">
              <span className="w-6 shrink-0 tabular-nums" style={{ color: "var(--fg-muted)" }}>
                {row.n}.
              </span>
              <span className="min-w-0 flex-1 whitespace-pre-wrap">{row.statement}</span>
              <Tooltip label={tooltipOf(row, t, language, time.dateTime)} multiline>
                <span data-testid={`criterion-${row.n}-verdict`}>
                  <StatusBadge family="criterion" value={criterionStandingOf(row.latest)} />
                </span>
              </Tooltip>
              {judge ? <RecordVerdict issueId={issueId} row={row} /> : null}
            </li>
          );
        })}
      </ol>
      <RetiredCriteria rows={retired} />
    </section>
  );
}

/** The retired criteria, collapsed: each marked Retired, with when, and every verdict it earned. */
function RetiredCriteria({ rows }: { rows: RetiredCriterionRow[] }) {
  const t = useCopy();
  const language = useInterfaceLanguage();
  const time = useTimeFormat();
  if (rows.length === 0) return null;
  return (
    <details className="mt-3 text-13" data-testid="retired-criteria">
      <summary className="cursor-pointer select-none font-medium text-muted hover:text-fg">
        {t("issues.criteria.retired", { n: rows.length })}
      </summary>
      <ol className="mt-1 divide-y divide-line-subtle">
        {rows.map((row) => (
          <li key={row.id} className="py-2" data-testid="retired-criterion">
            <div className="flex items-start gap-3">
              <span className="w-6 shrink-0 tabular-nums" style={{ color: "var(--fg-muted)" }}>
                {row.n}.
              </span>
              <span className="min-w-0 flex-1 whitespace-pre-wrap text-muted">{row.statement}</span>
              <span className="shrink-0 text-12 font-semibold text-muted" title={time.dateTime(row.retiredAt)} data-testid="retired-mark">
                {t("issues.criteria.retiredMark", { at: time.relative(row.retiredAt) })}
              </span>
            </div>
            {row.verdicts.length === 0 ? (
              <p className="mt-1 pl-9 text-12-5 text-subtle">{t("issues.verdict.none")}</p>
            ) : (
              <ul className="mt-1 grid gap-1 pl-9">
                {row.verdicts.map((v) => (
                  <li key={`${row.id}-${v.createdAt}`} className="flex items-start gap-2 text-12-5" data-testid="retired-verdict">
                    <StatusBadge family="criterion" value={criterionStandingOf(v)} />
                    <span className="min-w-0 flex-1 whitespace-pre-wrap text-muted">{verdictLines(v, t, language, time.dateTime)}</span>
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ol>
    </details>
  );
}
