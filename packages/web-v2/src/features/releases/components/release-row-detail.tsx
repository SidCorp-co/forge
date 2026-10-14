// What opens under a change's row on a release page: the full note where the row cut it, the issue
// and requirement it came from, its criteria proven and open, and its technical note, which a
// member's page reads from the Technical view only when a row is opened and a share never shows.

import type { ReleaseKnownIssue, ReleasePage, ReleasePageChange, ReleasePageProven } from "@forge/contracts/release-page";
import { Link } from "@/lib/navigation/router";
import { QueryBoundary } from "@/lib/api/query-boundary";
import { useCopy } from "@/lib/i18n/interface-language";
import { issueHref } from "@/lib/routes/issues";
import { requirementHref } from "@/lib/routes/requirements";
import { withoutCriterionCode } from "@/lib/utils/criterion-code";
import { useReleasePage } from "../hooks";
import type { Reach } from "./release-anchors";

export const STANDING_KEY = (s: ReleaseKnownIssue["standing"]) => `releases.page.known.${s}` as const;

/** One criterion as a line under a row: a mark, its wording without its code, and in the Technical view its issue and number. */
export function CheckLine({ text, mark, label }: { text: string; mark: string; label?: string | null }) {
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

/** The issue's technical note: on the page in the Technical view, else read from it when the reader opens a row; never on a share. */
export function TechnicalNote({ page, issueKey, reach }: { page: ReleasePage; issueKey: string; reach: Reach }) {
  const t = useCopy();
  if (page.technical) return <TechnicalNoteText text={page.technical.notes.find((n) => n.issueKey === issueKey)?.technical ?? null} />;
  if (!reach.authed) return null;
  return <TechnicalNoteRead projectId={page.projectId} version={page.header.version} issueKey={issueKey} label={t("releases.page.row.technicalLoading")} />;
}

export function TechnicalNoteRead({ projectId, version, issueKey, label }: { projectId: string; version: string; issueKey: string; label: string }) {
  const q = useReleasePage(projectId, version, "developer");
  return (
    <QueryBoundary query={q} loadingLabel={label}>
      {(dev) => <TechnicalNoteText text={dev.technical?.notes.find((n) => n.issueKey === issueKey)?.technical ?? null} />}
    </QueryBoundary>
  );
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

/** What opens under a row: the full note where the row cut it, its keys, its criteria, and its technical note. */
export function ChangeDetail({ page, change, checks, cut, reach }: { page: ReleasePage; change: ReleasePageChange; checks: IssueChecks | undefined; cut: boolean; reach: Reach }) {
  const t = useCopy();
  const developer = page.view === "developer";
  const proven = checks?.proven ?? [];
  const open = checks?.open ?? [];
  return (
    <div className="grid gap-3 pl-0.5" data-testid="page-row-detail">
      {cut ? <p className="text-14 text-fg">{change.line}</p> : null}
      <RowKeys issueKey={change.issueKey} requirementKey={checks?.requirement ?? null} slug={reach.slug} />
      {proven.length + open.length > 0 ? (
        <div className="grid gap-1">
          <span className="text-12 font-medium text-subtle">{t("releases.page.row.checks", { passed: proven.length, open: open.length })}</span>
          <ul className="grid gap-0.5">
            {open.map((k) => (
              <CheckLine key={`o:${k.statement}`} mark="○" text={`${withoutCriterionCode(k.statement)} (${t(STANDING_KEY(k.standing))})`} />
            ))}
            {proven.map((p) => (
              <CheckLine
                key={`p:${p.n ?? p.statement}`}
                mark={p.short ? "≈" : "✓"}
                text={developer ? p.statement : withoutCriterionCode(p.statement)}
                label={developer && p.n !== null ? `#${p.n}` : null}
              />
            ))}
          </ul>
        </div>
      ) : null}
      <TechnicalNote page={page} issueKey={change.issueKey} reach={reach} />
    </div>
  );
}
