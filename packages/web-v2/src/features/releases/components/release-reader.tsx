// The release as its reader reads it (REQ-40), shaped to be read in thirty seconds: where it stands
// and a plain summary first, then its changes counted at a glance, and each change
// as one short row in its group. Its contents sit in the facts rail beside it on a wide screen and are
// one menu at its top where there is no rail. Everything code-level (the full note, the issue and requirement
// keys, the criteria, the technical note) sits behind the row's own disclosure; the build, the range
// and the lists an engineer reads are the Technical view's. The same component draws a page in the
// app (a member, with links into the project) and a frozen page a share link opens (no links, no
// technical note), so the two cannot read differently.

import { RELEASE_CHANGE_GROUPS, type ReleaseGlance, releaseGlanceOf, releaseSummaryOf } from "@forge/contracts/release-digest";
import type { ReleasePage } from "@forge/contracts/release-page";
import { type ContentsItem, ContentsMenu, StatCell, StatRow } from "@/design";
import { useCopy, useTimeFormat } from "@/lib/i18n/interface-language";
import { verifiedSentence } from "../verified";
import { ANCHOR, type Anchor, GROUP_TITLE, type Reach } from "./release-anchors";
import { AdminSteps, ChangeGroup, OtherChanges, Requirements, StillOpen } from "./release-groups";
import { ReleaseHighlightList } from "./release-highlights";
import { checksByIssue } from "./release-row-detail";
import { Technical } from "./release-technical";

/** Where the release stands in one line: live and where, or not yet; who approved; what it proved; whether an admin owes a step. */
function ReleaseStanding({ page }: { page: ReleasePage }) {
  const t = useCopy();
  const time = useTimeFormat();
  const h = page.header;
  const a = h.approval;
  const where = h.environment?.url ?? h.environment?.name ?? null;
  const live =
    h.releasedAt && where
      ? t("releases.page.status.live", { where, at: time.date(h.releasedAt) })
      : h.releasedAt
        ? t("releases.page.status.released", { at: time.date(h.releasedAt) })
        : `${t("releases.page.status.notReleased")}, ${t("releases.page.status.notDeployed")}`;
  const approval =
    a.state === "approved" && a.by
      ? a.at
        ? t("releases.page.approval.approvedAt", { who: a.by.name, at: time.date(a.at) })
        : t("releases.page.approval.approved", { who: a.by.name })
      : t(`releases.page.approval.${a.state}`);
  // where the range was not read, no admin step is claimed absent: it says it was not checked
  const admin =
    page.actionRequired.length > 0 ? null : page.shipped.state === "read" ? t("releases.page.admin.none") : t("releases.page.admin.unchecked");
  const facts = [live, approval, verifiedSentence(h.verified, t), ...(admin ? [admin] : [])];
  return (
    <p className="flex flex-wrap gap-x-2 gap-y-0.5 text-13 text-muted" data-testid="page-header" data-state={h.state} data-approval={a.state}>
      {facts.map((f, i) => (
        <span key={f} className="whitespace-normal">
          {i > 0 ? <span className="mr-2 text-neutral-8">·</span> : null}
          {f}
        </span>
      ))}
    </p>
  );
}

/** Two to four plain lines a product owner reads first (`release-digest.ts:releaseSummaryOf`), or why there is none. */
function ReleaseSummaryLines({ page }: { page: ReleasePage }) {
  const t = useCopy();
  const summary = releaseSummaryOf(page);
  if (summary.state === "refused") {
    return (
      <p className="text-14 text-muted" data-testid="page-summary" data-state="refused" data-code={summary.refusal.code}>
        {t("releases.page.summary.refused", { detail: summary.refusal.detail })}
      </p>
    );
  }
  return (
    <div className="grid gap-1" aria-label={t("releases.page.summary.label")} data-testid="page-summary" data-state="derived">
      {summary.lines.map((line, i) => (
        <p key={line} className={i === 0 ? "text-16 font-medium leading-snug text-fg" : "text-14 leading-snug text-fg"}>
          {line}
        </p>
      ))}
    </div>
  );
}

/** The changes counted by group, each cell a link to its group; a group with nothing in it is counted and not linked. */
function ReleaseCounts({ glance }: { glance: ReleaseGlance }) {
  const t = useCopy();
  const cells: { key: Anchor; n: number }[] = [
    ...RELEASE_CHANGE_GROUPS.map((g) => ({ key: g, n: glance.groups[g].length })),
    { key: "other", n: glance.other },
    { key: "open", n: glance.open.issues },
  ];
  return (
    <nav aria-label={t("releases.page.glance.label")} data-testid="page-glance">
      <StatRow testId="page-glance-row" cellMin={110} cells={cells.length}>
        {cells.map((c) => (
          <StatCell
            key={c.key}
            label={t(GROUP_TITLE[c.key as keyof typeof GROUP_TITLE])}
            value={c.n}
            href={c.n > 0 ? `#${ANCHOR[c.key]}` : undefined}
            tone={c.key === "open" && c.n > 0 ? "you" : undefined}
            testId={`page-glance-${c.key}`}
          />
        ))}
      </StatRow>
    </nav>
  );
}

/** The groups the page draws, in reading order, so its contents name exactly what is on it. */
function shownGroups(page: ReleasePage, glance: ReleaseGlance): Anchor[] {
  return [
    ...(page.highlights.state === "none" ? [] : (["highlights"] as const)),
    ...RELEASE_CHANGE_GROUPS.filter((g) => glance.groups[g].length > 0),
    ...(page.requirements.length > 0 ? (["requirements"] as const) : []),
    ...(page.knownIssues.length > 0 ? (["open"] as const) : []),
    ...(page.withoutNotes.length > 0 ? (["other"] as const) : []),
    ...(page.actionRequired.length > 0 ? (["admin"] as const) : []),
    ...(page.technical ? (["technical"] as const) : []),
  ];
}

/** The page's contents: one item per group it draws, each naming the anchor the group starts at. */
export function useReleaseContents(page: ReleasePage | undefined): ContentsItem[] {
  const t = useCopy();
  if (!page) return [];
  return shownGroups(page, releaseGlanceOf(page)).map((a) => ({
    id: ANCHOR[a],
    label: a === "highlights" ? t("releases.page.highlights.title") : t(GROUP_TITLE[a]),
  }));
}

/**
 * `slug` is set where the reader is a member in the app (keys link into the project); `authed` says
 * the media are issue attachments behind the session rather than tickets a share link minted, and
 * that a row may read its technical note. `railContents` says a facts rail beside the page lists the
 * contents on a wide screen, so the menu here shows only where that rail has collapsed.
 */
export function ReleaseReader({ page, slug, authed, railContents = false }: { page: ReleasePage; slug?: string | undefined; authed: boolean; railContents?: boolean }) {
  const t = useCopy();
  const contents = useReleaseContents(page);
  const glance = releaseGlanceOf(page);
  const checks = checksByIssue(page);
  const reach: Reach = { slug, authed };
  return (
    <div className="grid gap-6" data-testid="release-reader" data-view={page.view} data-tour="rel-users">
      <ContentsMenu items={contents} label={t("releases.page.contents")} testId="page-contents" className={railContents ? "-mb-4 lg:hidden" : "-mb-4"} />
      <div className="grid gap-3">
        <ReleaseSummaryLines page={page} />
        <ReleaseStanding page={page} />
      </div>
      <ReleaseCounts glance={glance} />
      {/* each group's list ends on a hairline; a second one over the next group's title would box it */}
      <div className="grid [&>section]:border-t-0">
        <div id={ANCHOR.highlights} className="scroll-mt-24 pt-5 empty:hidden">
          <ReleaseHighlightList highlights={page.highlights} slug={slug} authed={authed} />
        </div>
        {RELEASE_CHANGE_GROUPS.map((g) => (
          <ChangeGroup key={g} group={g} rows={glance.groups[g]} page={page} checks={checks} reach={reach} />
        ))}
        <Requirements page={page} slug={slug} />
        <StillOpen page={page} reach={reach} />
        <OtherChanges page={page} reach={reach} />
        <AdminSteps page={page} />
        <Technical page={page} slug={slug} />
      </div>
    </div>
  );
}
