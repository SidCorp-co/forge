// What opens under a change's row on a release page: the sentence that says it in full and the issue
// and requirement it came from; on the Technical view, its criteria proven and open and its technical
// note as well. A share shows neither criteria nor technical note.

import type { ReleaseKnownIssue, ReleasePage, ReleasePageChange, ReleasePageProven } from "@forge/contracts/release-page";
import { Link } from "@/lib/navigation/router";
import type { ReactNode } from "react";
import { HollowCheck, statusReading } from "@/design";
import { useCopy, useInterfaceLanguage } from "@/lib/i18n/interface-language";
import { issueHref } from "@/lib/routes/issues";
import { requirementHref } from "@/lib/routes/requirements";
import { withoutCriterionCode } from "@/lib/utils/criterion-code";
import type { Reach } from "./release-anchors";

/**
 * A short among the proven lines, drawn as the Criteria tab draws it: the hollow ✓ in the warn tone,
 * named Short, never the pass's ✓ (forge-core-eb, 2026-10-14).
 */
function ShortMark() {
  const reading = statusReading("criterion", "short", useInterfaceLanguage()).label;
  return (
    <span className="inline-flex text-warn-11" role="img" aria-label={reading} title={reading} data-testid="proof-short-mark">
      <HollowCheck />
    </span>
  );
}

export const STANDING_KEY = (s: ReleaseKnownIssue["standing"]) => `releases.page.known.${s}` as const;

/** One criterion as a line under a row: a mark, its wording without its code, and in the Technical view its issue and number. */
export function CheckLine({ text, mark, label }: { text: string; mark: ReactNode; label?: string | null }) {
  return (
    <li className="flex gap-2 text-12 text-muted">
      <span className="w-3 flex-none text-center">{mark}</span>
      <span className="min-w-0 flex-1 break-words">
        {label ? <span className="mr-1.5 font-mono text-subtle">{label}</span> : null}
        {text}
      </span>
    </li>
  );
}

/** The issue's technical note, as the Technical view carries it; a share and the overview never show one. */
export function TechnicalNote({ page, issueKey }: { page: ReleasePage; issueKey: string }) {
  if (!page.technical) return null;
  return <TechnicalNoteText text={page.technical.notes.find((n) => n.issueKey === issueKey)?.technical ?? null} />;
}

export function TechnicalNoteText({ text }: { text: string | null }) {
  const t = useCopy();
  return (
    <div className="grid gap-0.5" data-testid="page-row-technical">
      <span className="text-12 font-medium text-subtle">{t("releases.page.row.technical")}</span>
      <p className="break-words text-12 text-muted">{text ?? t("releases.page.row.noTechnical")}</p>
    </div>
  );
}

/** Links to the issue and the requirement a row came from: in the app only. */
export function RowKeys({ issueKey, requirementKey, slug }: { issueKey: string; requirementKey: string | null; slug?: string | undefined }) {
  const t = useCopy();
  const cls = "font-mono text-12 text-link hover:underline";
  return (
    <span className="flex flex-wrap gap-x-4 gap-y-0.5">
      {slug ? (
        <Link href={issueHref(slug, issueKey)} className={cls}>
          {t("releases.page.row.issue", { key: issueKey })}
        </Link>
      ) : (
        <span className="font-mono text-12 text-subtle">{t("releases.page.row.issue", { key: issueKey })}</span>
      )}
      {requirementKey ? (
        slug ? (
          <Link href={requirementHref(slug, requirementKey)} className={cls}>
            {t("releases.page.row.requirement", { key: requirementKey })}
          </Link>
        ) : (
          <span className="font-mono text-12 text-subtle">{t("releases.page.row.requirement", { key: requirementKey })}</span>
        )
      ) : null}
    </span>
  );
}

/** Each issue's proven criteria, open criteria and requirement, read once off the page. */
export interface IssueChecks {
  proven: ReleasePageProven[];
  open: ReleaseKnownIssue[];
  requirement: string | null;
}

export function checksByIssue(page: ReleasePage): Map<string, IssueChecks> {
  const out = new Map<string, IssueChecks>();
  const at = (key: string) => {
    const got = out.get(key) ?? { proven: [], open: [], requirement: null };
    out.set(key, got);
    return got;
  };
  for (const r of page.requirements)
    for (const p of r.proven)
      if (p.issueKey) {
        const c = at(p.issueKey);
        c.proven.push(p);
        c.requirement = r.key;
      }
  for (const p of page.untraced?.proven ?? []) if (p.issueKey) at(p.issueKey).proven.push(p);
  for (const k of page.knownIssues) {
    const c = at(k.issueKey);
    c.open.push(k);
    c.requirement ??= k.requirementKey;
  }
  return out;
}

/**
 * What opens under a change's row. On the overview: the sentence that says it in full and where to
 * read more (its issue, its requirement, its technical details), never a criterion (BC-15). On the
 * Technical view: its criteria proven and open, and its technical note, as well.
 */
export function ChangeDetail({ page, change, checks, reach }: { page: ReleasePage; change: ReleasePageChange; checks: IssueChecks | undefined; reach: Reach }) {
  const t = useCopy();
  const developer = page.view === "developer";
  const proven = checks?.proven ?? [];
  const open = checks?.open ?? [];
  const requirementKey = change.requirementKey ?? checks?.requirement ?? null;
  return (
    <div className="grid gap-3 pl-0.5" data-testid="page-row-detail">
      {change.detail ? (
        <p className="max-w-prose text-14 text-muted" data-testid="page-row-sentence">
          {change.detail}
        </p>
      ) : null}
      <span className="flex flex-wrap gap-x-4 gap-y-0.5">
        <RowKeys issueKey={change.issueKey} requirementKey={requirementKey} slug={reach.slug} />
        {!developer && reach.slug ? (
          <Link href="?view=developer#release-technical" className="text-12 text-link hover:underline" data-testid="page-row-technical-link">
            {t("releases.page.row.technicalLink")}
          </Link>
        ) : null}
      </span>
      {developer && proven.length + open.length > 0 ? (
        <div className="grid gap-1">
          <span className="text-12 font-medium text-subtle">{t("releases.page.row.checks", { passed: proven.length, open: open.length })}</span>
          <ul className="grid gap-0.5">
            {open.map((k) => (
              <CheckLine key={`o:${k.statement}`} mark="○" text={`${withoutCriterionCode(k.statement)} (${t(STANDING_KEY(k.standing))})`} />
            ))}
            {proven.map((p) => (
              <CheckLine key={`p:${p.n ?? p.statement}`} mark={p.short ? <ShortMark /> : "✓"} text={p.statement} label={p.n !== null ? `#${p.n}` : null} />
            ))}
          </ul>
        </div>
      ) : null}
      {developer ? <TechnicalNote page={page} issueKey={change.issueKey} /> : null}
    </div>
  );
}
