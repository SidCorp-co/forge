"use client";

// Running and At risk on the project home: flat tables on hairlines, no cards. What is running and
// what is late is core's project status; the rows come from `derive.ts` and nothing is decided here.

import Link from "next/link";
import { WaitingOn } from "@/design";
import { spanText } from "@/features/forecast/text";
import { issueHref } from "@/lib/routes/issues";
import { useCopy, useInterfaceLanguage } from "@/lib/i18n/interface-language";
import type { Copy } from "@/lib/i18n/product-copy";
import type { AtRiskReason, AtRiskRow } from "../derive";
import type { StatusInFlightIssue } from "@forge/contracts/project-status";

const TH = "fg-caption border-b border-line px-0 py-1.5 pr-3 text-left font-medium text-muted";
const TD = "border-b border-line-subtle py-2 pr-3 align-top text-13";
const KEY = "font-mono text-12-5 font-semibold text-link hover:underline whitespace-nowrap";

export function HomeSectionTitle({ children, count }: { children: React.ReactNode; count?: number | undefined }) {
  return (
    <h2 className="fg-h3 mb-1 flex items-baseline gap-2 text-fg">
      {children}
      {count != null && count > 0 ? <span className="fg-caption font-normal text-muted">{count}</span> : null}
    </h2>
  );
}

export function RunningTable({ rows, total, slug }: { rows: StatusInFlightIssue[]; total: number; slug: string }) {
  const t = useCopy();
  return (
    <section aria-label={t("home.running")} data-testid="home-running">
      <HomeSectionTitle count={total}>{t("home.running")}</HomeSectionTitle>
      {rows.length === 0 ? (
        <p className="text-13 text-muted">{t("home.runningEmpty")}</p>
      ) : (
        <table className="w-full border-collapse">
          <thead>
            <tr>
              <th className={TH}>{t("home.col.key")}</th>
              <th className={TH}>{t("home.col.title")}</th>
              <th className={`${TH} max-sm:hidden`}>{t("home.col.waiting")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key} data-testid="home-running-row" data-key={r.key}>
                <td className={TD}>
                  <Link className={KEY} href={issueHref(slug, r.key)}>
                    {r.key}
                  </Link>
                </td>
                <td className={`${TD} min-w-0 break-words`}>{r.title}</td>
                <td className={`${TD} max-sm:hidden`}>
                  <WaitingOn w={r.waitingOn} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {total > rows.length && <p className="fg-caption mt-1 text-subtle">{t("home.runningMore", { shown: rows.length, total })}</p>}
    </section>
  );
}

function whyText(r: AtRiskReason, t: Copy, lang: "en" | "vi"): string {
  if (r.kind === "short") return t("home.why.short", { proven: r.proven, total: r.total });
  const by = spanText(r.late.byMinutes, lang);
  return r.late.reason === "p85_passed" ? t("home.why.past", { by }) : t("home.why.waiting", { by });
}

export function AtRiskTable({ rows }: { rows: AtRiskRow[] }) {
  const t = useCopy();
  const lang = useInterfaceLanguage();
  return (
    <section aria-label={t("home.atRisk")} data-testid="home-at-risk">
      <HomeSectionTitle count={rows.length}>{t("home.atRisk")}</HomeSectionTitle>
      {rows.length === 0 ? (
        <p className="text-13 text-muted">{t("home.atRiskEmpty")}</p>
      ) : (
        <table className="w-full border-collapse">
          <thead>
            <tr>
              <th className={TH}>{t("home.col.key")}</th>
              <th className={TH}>{t("home.col.title")}</th>
              <th className={`${TH} max-sm:hidden`}>{t("home.col.why")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.entity}:${r.key}`} data-testid="home-at-risk-row" data-key={r.key}>
                <td className={TD}>
                  <Link className={KEY} href={r.href}>
                    {r.key}
                  </Link>
                </td>
                <td className={`${TD} min-w-0 break-words`}>
                  {r.title}
                  <span className="mt-0.5 hidden text-12-5 text-[var(--accent-text)] max-sm:block">{r.reasons.map((x) => whyText(x, t, lang)).join(" · ")}</span>
                </td>
                <td className={`${TD} text-12-5 text-[var(--accent-text)] max-sm:hidden`} data-testid="home-at-risk-why">
                  {r.reasons.map((x) => whyText(x, t, lang)).join(" · ")}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
