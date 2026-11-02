
// Running and At risk on the project home: flush rows on hairlines, no cards. What is running and
// what is late is core's project status; the rows come from `derive.ts` and nothing is decided here.
// An at-risk row is its title and one chip, Stuck or Late; why, and the steward's line, are that
// chip's hover (ISS-903). The home draws neither when it holds nothing.

import { RowItem, RowList, StatusChip, WaitingOn } from "@/design";
import { spanText } from "@/features/forecast";
import { Link } from "@/lib/navigation/router";
import { issueHref } from "@/lib/routes/issues";
import { useCopy, useInterfaceLanguage } from "@/lib/i18n/interface-language";
import type { Copy } from "@/lib/i18n/product-copy";
import type { AtRiskReason, AtRiskRow } from "../derive";
import type { StatusInFlightIssue } from "@forge/contracts/project-status";


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
    <section id="running" aria-label={t("home.running")} data-testid="home-running" className="scroll-mt-24">
      <HomeSectionTitle count={total}>{t("home.running")}</HomeSectionTitle>
      {rows.length > 0 ? (
        <RowList label={t("home.running")}>
          {rows.map((r) => (
            <RowItem key={r.key} testId="home-running-row" rowKey={r.key} href={issueHref(slug, r.key)} tip={r.key} title={r.title} trailing={<WaitingOn w={r.waitingOn} />} />
          ))}
        </RowList>
      ) : null}
      {total > rows.length && <p className="fg-caption mt-1 text-subtle">{t("home.runningMore", { shown: rows.length, total })}</p>}
    </section>
  );
}

function whyText(r: AtRiskReason, t: Copy, lang: "en" | "vi"): string {
  if (r.kind === "stuck") return r.reason;
  // a live read is late only past its p85; a person's wait is late by its standing's due, read stuck above
  return t("home.why.past", { by: spanText(r.late.byMinutes, lang) });
}

/** The steward's line 1 under a stuck row, where one is written and current (REQ-48 BC-7). */
function noteOf(r: AtRiskRow): string | null {
  for (const x of r.reasons) if (x.kind === "stuck" && x.note) return x.note;
  return null;
}

/**
 * `unlisted`: stuck issues and feedback the status read counts and does not list (every stuck
 * requirement is listed), linked to `moreHref`, where the Stuck group lists them.
 */
export function AtRiskTable({ rows, unlisted = 0, moreHref }: { rows: AtRiskRow[]; unlisted?: number; moreHref?: string }) {
  const t = useCopy();
  const lang = useInterfaceLanguage();
  return (
    <section id="at-risk" aria-label={t("home.atRisk")} data-testid="home-at-risk" className="scroll-mt-24">
      <HomeSectionTitle count={rows.length + unlisted}>{t("home.atRisk")}</HomeSectionTitle>
      {rows.length > 0 ? (
        <RowList label={t("home.atRisk")}>
          {rows.map((r) => (
            <RowItem
              key={`${r.entity}:${r.key}`}
              testId="home-at-risk-row"
              rowKey={r.key}
              href={r.href}
              tip={r.key}
              title={r.title}
              trailing={
                <StatusChip
                  tone="err"
                  label={t(r.reasons[0]?.kind === "stuck" ? "home.risk.stuck" : "home.risk.late")}
                  reason={[r.reasons.map((x) => whyText(x, t, lang)).join(" · "), noteOf(r)].filter(Boolean).join(" — ")}
                  testId="home-at-risk-why"
                />
              }
            />
          ))}
        </RowList>
      ) : null}
      {unlisted > 0 &&
        (moreHref ? (
          <Link href={moreHref} className="fg-caption text-fg underline-offset-2 hover:underline" data-testid="home-at-risk-unlisted">
            {t("home.atRiskUnlisted", { n: unlisted })}
          </Link>
        ) : (
          <p className="fg-caption text-subtle" data-testid="home-at-risk-unlisted">
            {t("home.atRiskUnlisted", { n: unlisted })}
          </p>
        ))}
    </section>
  );
}
