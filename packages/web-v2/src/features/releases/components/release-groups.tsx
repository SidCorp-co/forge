// The groups of a release page, each change, requirement and open issue as one short row in the
// reader's words with its detail one click away (`release-row-detail.tsx`), and the admin steps where
// there are any. Flush rows under a heading: no card, no box in a box.

import type { ReleaseChangeGroup } from "@forge/contracts/release-digest";
import { releaseRowHeadline } from "@forge/contracts/release-digest";
import { actionSaysRef, type ReleaseKnownIssue, type ReleasePage, type ReleasePageChange, type ReleasePageRequirement } from "@forge/contracts/release-page";
import { useState } from "react";
import { Link } from "@/lib/navigation/router";
import { RowItem, RowList, Section } from "@/design";
import { useCopy } from "@/lib/i18n/interface-language";
import { issueHref } from "@/lib/routes/issues";
import { requirementHref } from "@/lib/routes/requirements";
import { withoutCriterionCode } from "@/lib/utils/criterion-code";
import { shortSha } from "./release-bits";
import { ANCHOR, GROUP_TITLE, type Reach } from "./release-anchors";
import { ChangeDetail, CheckLine, type IssueChecks, RowKeys, STANDING_KEY } from "./release-row-detail";

/** One change as one short row in user language; its key small at the right, its detail one click away. */
export function ChangeLine({ page, change, checks, reach }: { page: ReleasePage; change: ReleasePageChange; checks: IssueChecks | undefined; reach: Reach }) {
  const t = useCopy();
  const [open, setOpen] = useState(false);
  const head = releaseRowHeadline(change.line);
  const openChecks = checks?.open.length ?? 0;
  return (
    <RowItem
      wrap
      expanded={open}
      onClick={() => setOpen((o) => !o)}
      title={head.text}
      trailing={
        <span className="flex items-center gap-2 text-12 text-subtle">
          {openChecks > 0 ? <span className="font-medium text-warn-11">{t("releases.page.row.open", { n: openChecks })}</span> : null}
          <span className="font-mono">{change.issueKey}</span>
          <span aria-hidden className={open ? "rotate-90 transition-transform" : "transition-transform"}>
            ›
          </span>
        </span>
      }
      testId="page-change"
      rowKey={change.issueKey}
    >
      {open ? <ChangeDetail page={page} change={change} checks={checks} cut={head.cut} reach={reach} /> : null}
    </RowItem>
  );
}

export function ChangeGroup({ group, rows, page, checks, reach }: { group: ReleaseChangeGroup; rows: ReleasePageChange[]; page: ReleasePage; checks: Map<string, IssueChecks>; reach: Reach }) {
  const t = useCopy();
  if (rows.length === 0) return null;
  return (
    <Section id={ANCHOR[group]} title={<GroupTitle title={t(GROUP_TITLE[group])} n={rows.length} />} testId={`page-group-${group}`} data-kind={group}>
      <RowList label={t(GROUP_TITLE[group])}>
        {rows.map((c) => (
          <ChangeLine key={`${c.issueKey}:${c.line}`} page={page} change={c} checks={checks.get(c.issueKey)} reach={reach} />
        ))}
      </RowList>
    </Section>
  );
}

export function GroupTitle({ title, n }: { title: string; n: number }) {
  return (
    <>
      {title}
      <span className="ml-2 text-13 font-medium text-muted">{n}</span>
    </>
  );
}

/** A requirement the release completes or moves forward: its title and outcome in one row; its own criteria proven, behind the row. */
export function RequirementLine({ r, slug }: { r: ReleasePageRequirement; slug?: string | undefined }) {
  const t = useCopy();
  const [open, setOpen] = useState(false);
  return (
    <RowItem
      wrap
      expanded={open}
      onClick={() => setOpen((o) => !o)}
      lead={<span className="w-24 text-left font-sans text-12 font-semibold text-muted max-md:w-auto">{t(r.completes ? "releases.page.requirement.completes" : "releases.page.requirement.advances")}</span>}
      title={r.title}
      trailing={
        <span className="flex items-center gap-2 text-12 text-subtle">
          <span>{t("releases.page.requirement.passed", { n: r.proven.length })}</span>
          <span className="font-mono">{r.key}</span>
          <span aria-hidden className={open ? "rotate-90 transition-transform" : "transition-transform"}>
            ›
          </span>
        </span>
      }
      testId="page-requirement"
      rowKey={r.key}
    >
      {open ? (
        <div className="grid gap-2" data-testid="page-requirement-detail" data-outcome={r.completes ? "completes" : "advances"}>
          {slug ? (
            <Link href={requirementHref(slug, r.key)} className="font-mono text-12 text-link hover:underline">
              {t("releases.page.row.requirement", { key: r.key })}
            </Link>
          ) : null}
          {r.business ? (
            <>
              <span className="text-12 font-medium text-subtle" data-testid="page-requirement-count" data-proven={r.business.proven.length} data-total={r.business.total}>
                {t("releases.page.requirement.business", { proven: r.business.proven.length, total: r.business.total })}
              </span>
              <ul className="grid gap-0.5">
                {r.business.proven.map((c) => (
                  <CheckLine key={c.code} mark="✓" text={c.statement} label={c.code} />
                ))}
              </ul>
            </>
          ) : null}
        </div>
      ) : null}
    </RowItem>
  );
}

export function Requirements({ page, slug }: { page: ReleasePage; slug?: string | undefined }) {
  const t = useCopy();
  if (page.requirements.length === 0) return null;
  return (
    <Section id={ANCHOR.requirements} title={<GroupTitle title={t(GROUP_TITLE.requirements)} n={page.requirements.length} />} testId="page-requirements">
      <RowList label={t(GROUP_TITLE.requirements)}>
        {page.requirements.map((r) => (
          <RequirementLine key={r.key} r={r} slug={slug} />
        ))}
      </RowList>
    </Section>
  );
}

/** One issue with criteria not proven on the build: what it is in a line, how many are open, and each one behind the row. */
export function OpenLine({ issueKey, title, open, page, reach }: { issueKey: string; title: string; open: ReleaseKnownIssue[]; page: ReleasePage; reach: Reach }) {
  const t = useCopy();
  const [shown, setShown] = useState(false);
  const developer = page.view === "developer";
  return (
    <RowItem
      wrap
      expanded={shown}
      onClick={() => setShown((o) => !o)}
      title={title}
      trailing={
        <span className="flex items-center gap-2 text-12 text-subtle">
          <span className="font-medium text-warn-11">{t("releases.page.row.open", { n: open.length })}</span>
          <span className="font-mono">{issueKey}</span>
          <span aria-hidden className={shown ? "rotate-90 transition-transform" : "transition-transform"}>
            ›
          </span>
        </span>
      }
      testId="page-known-issue"
      rowKey={issueKey}
    >
      {shown ? (
        <div className="grid gap-2">
          <RowKeys issueKey={issueKey} requirementKey={open[0]?.requirementKey ?? null} slug={reach.slug} />
          <ul className="grid gap-0.5">
            {open.map((k) => (
              <li key={k.statement} className="grid gap-0.5" data-standing={k.standing}>
                <CheckLine mark="○" text={`${withoutCriterionCode(k.statement)} (${t(STANDING_KEY(k.standing))})`} />
                {developer && k.reason ? <span className="pl-5 text-12 text-subtle">{k.reason}</span> : null}
                {developer && k.elsewhere ? (
                  <span className="pl-5 text-12 text-subtle">
                    {t("releases.page.known.elsewhere", { verdict: k.elsewhere.verdict, build: k.elsewhere.commitSha ? shortSha(k.elsewhere.commitSha) : "-" })}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </RowItem>
  );
}

export function StillOpen({ page, reach }: { page: ReleasePage; reach: Reach }) {
  const t = useCopy();
  if (page.knownIssues.length === 0) return null;
  const byIssue = new Map<string, ReleaseKnownIssue[]>();
  for (const k of page.knownIssues) byIssue.set(k.issueKey, [...(byIssue.get(k.issueKey) ?? []), k]);
  const lineOf = (key: string) => [...page.improvements, ...page.fixes].find((c) => c.issueKey === key)?.line;
  const titleOf = (key: string) => {
    const line = lineOf(key);
    return line ? releaseRowHeadline(line).text : (page.withoutNotes.find((w) => w.issueKey === key)?.title ?? key);
  };
  return (
    <Section id={ANCHOR.open} title={<GroupTitle title={t(GROUP_TITLE.open)} n={byIssue.size} />} testId="page-known-issues">
      <RowList label={t(GROUP_TITLE.open)}>
        {[...byIssue].map(([key, open]) => (
          <OpenLine key={key} issueKey={key} title={titleOf(key)} open={open} page={page} reach={reach} />
        ))}
      </RowList>
    </Section>
  );
}

export function OtherChanges({ page, reach }: { page: ReleasePage; reach: Reach }) {
  const t = useCopy();
  if (page.withoutNotes.length === 0) return null;
  return (
    <Section id={ANCHOR.other} title={<GroupTitle title={t(GROUP_TITLE.other)} n={page.withoutNotes.length} />} testId="page-unnoted">
      <RowList label={t(GROUP_TITLE.other)}>
        {page.withoutNotes.map((w) => (
          <RowItem
            key={w.issueKey}
            wrap
            dim
            title={w.title}
            facts={[t(`releases.page.unnoted.${w.why}`)]}
            note={page.technical?.notes.find((n) => n.issueKey === w.issueKey)?.technical}
            trailing={
              reach.slug ? (
                <Link href={issueHref(reach.slug, w.issueKey)} className="font-mono text-12 text-subtle hover:text-link hover:underline">
                  {w.issueKey}
                </Link>
              ) : (
                <span className="font-mono text-12 text-subtle">{w.issueKey}</span>
              )
            }
            testId="page-unnoted-row"
          />
        ))}
      </RowList>
    </Section>
  );
}

/** What an admin must do once the release lands (BC-7): shown only where there is something to do. */
export function AdminSteps({ page }: { page: ReleasePage }) {
  const t = useCopy();
  if (page.actionRequired.length === 0) return null;
  return (
    <Section id={ANCHOR.admin} title={<GroupTitle title={t(GROUP_TITLE.admin)} n={page.actionRequired.length} />} testId="page-actions">
      <RowList label={t(GROUP_TITLE.admin)}>
        {page.actionRequired.map((a) => (
          <RowItem key={`${a.kind}:${a.ref}`} wrap title={a.sentence} facts={actionSaysRef(a) ? undefined : [<span key="ref" className="font-mono">{a.ref}</span>]} testId="page-action" />
        ))}
      </RowList>
    </Section>
  );
}
