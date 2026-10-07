"use client";

// ISS-55 — the issue's acceptance criteria, flat: one row per criterion with its verdict badge.
// The identity, reason, author and time sit behind the badge's tooltip, not on the row.

import { PageSectionTitle, EmptyPanelLine, StatusBadge, statusReading, Tooltip } from "@/design";
import { formatApiError } from "@/lib/api/error";
import { useCopy, useInterfaceLanguage, useTimeFormat } from "@/lib/i18n/interface-language";
import type { Copy } from "@/lib/i18n/product-copy";
import { criterionStandingOf } from "@forge/contracts/verdict-identity";
import { identityPhrase } from "../identity-phrase";
import { type CriterionRow, useCriteria } from "../criteria";

function tooltipOf(row: CriterionRow, t: Copy, language: string, at: (iso: string) => string): string {
  const v = row.latest;
  if (!v) return t("issues.verdict.none");
  const by = v.authorAgency === "agent" ? t("issues.verdict.byAgent") : t("issues.verdict.byPerson");
  const parts = [
    `${v.verdict === "short" ? t("issues.verdict.short") : statusReading("criterion", v.verdict, language).label} · ${identityPhrase(v, t)}`,
    v.reason ? t("issues.verdict.reason", { reason: v.reason }) : null,
    t("issues.verdict.by", { by, at: at(v.createdAt) }),
  ];
  return parts.filter(Boolean).join("\n");
}

export function CriteriaList({ issueId }: { issueId: string }) {
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
  if (rows.length === 0) return null;
  return (
    <section aria-label={t("issues.criteria.acceptance")}>
      <PageSectionTitle className="mb-2">{t("issues.criteria.acceptance")}</PageSectionTitle>
      <ol className="divide-y" style={{ borderColor: "var(--border-subtle)" }}>
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
            </li>
          );
        })}
      </ol>
    </section>
  );
}
