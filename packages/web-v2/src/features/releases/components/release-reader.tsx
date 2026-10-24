// The release as its reader reads it (REQ-40), shaped to be read in under a minute: the summary it was
// given and its changes counted in one line, its highlights, what an admin must do before it goes
// out, then each change in its group as its short title, whole, with the sentence that says it in full
// one click away. The overview holds no criterion, code, commit or path (BC-15): those, the changes
// nobody using the product sees (BC-16) and the requirements' criteria are the Technical view's. The
// same component draws a page in the app (a member, with links into the project) and a frozen page a
// share link opens (no links, no technical note), so the two cannot read differently.

import { type ReactNode, useState } from "react";
import { RELEASE_CHANGE_GROUPS, type ReleaseGlance, releaseGlanceOf } from "@forge/contracts/release-digest";
import type { ReleasePage } from "@forge/contracts/release-page";
import { type ContentsItem, ContentsMenu, DetailLeadEnd, RowItem, RowList, Section } from "@/design";
import { useCopy } from "@/lib/i18n/interface-language";
import { Link } from "@/lib/navigation/router";
import { ANCHOR, type Anchor, GROUP_TITLE, type Reach } from "./release-anchors";
import { BeforeYouRelease, ChangeGroup, GroupTitle, OtherChanges, Requirements, StillOpen } from "./release-groups";
import { DisclosureToggle } from "./release-bits";
import { ReleaseHighlightList } from "./release-highlights";
import { checksByIssue } from "./release-row-detail";
import { Technical } from "./release-technical";

/**
 * The summary the release was given once drafted (BC-14), whole. A release nobody named yet says the
 * assistant is naming it, or, where its draft was refused, says so with why behind a fold and who
 * names it instead (ISS-590): a page never opens on a silent blank.
 */
function ReleaseSummary({ page }: { page: ReleasePage }) {
  const t = useCopy();
  const [open, setOpen] = useState(false);
  const summary = page.header.summary;
  const naming = page.header.naming;
  if (summary)
    return (
      <p className="max-w-prose text-16 leading-relaxed text-fg" data-testid="page-summary">
        {summary}
      </p>
    );
  if (naming?.state === "drafting")
    return (
      <p className="text-14 text-muted" data-testid="page-naming-drafting">
        {t("releases.page.naming.drafting")}
      </p>
    );
  if (naming?.state !== "failed") return null;
  const namer = page.header.namer;
  return (
    <div data-testid="page-naming-failed">
      {namer ? (
        <p className="text-14 text-muted" data-testid="page-naming-namer">
          {namer.to === "admins" ? t("releases.page.namer.admins", { names: namer.names.join(", ") }) : t(`releases.page.namer.${namer.to}`)}
        </p>
      ) : null}
      <DisclosureToggle open={open} onToggle={() => setOpen((o) => !o)} className="text-14" testId="page-naming-failed-toggle">
        {t("releases.page.naming.failed")}
      </DisclosureToggle>
      {open ? (
        <ul className="mt-1 grid gap-0.5 text-12 text-subtle">
          {naming.refusals.map((r) => (
            <li key={`${r.code}:${r.path}`}>
              <span className="font-mono">{r.code}</span> {r.detail}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** The changes counted in one line, each count a link to its group. */
function ReleaseTally({ glance }: { glance: ReleaseGlance }) {
  const t = useCopy();
  const counted = RELEASE_CHANGE_GROUPS.filter((g) => glance.groups[g].length > 0);
  if (counted.length === 0) return null;
  return (
    <p className="flex flex-wrap gap-x-4 gap-y-1 text-14 text-muted" data-testid="page-tally">
      {counted.map((g) => (
        <a key={g} href={`#${ANCHOR[g]}`} className="hover:text-link" data-testid={`page-tally-${g}`}>
          {t(`releases.page.tally.${g}`, { n: glance.groups[g].length })}
        </a>
      ))}
    </p>
  );
}

/**
 * What nobody using the product sees (BC-16), and the changes with no note for users yet: counted in
 * one line on the overview, pointing at the Technical view; listed there.
 */
function InternalChanges({ page, glance, reach }: { page: ReleasePage; glance: ReleaseGlance; reach: Reach }) {
  const t = useCopy();
  if (page.view === "developer") {
    const rows = page.internal.changes ?? [];
    if (rows.length === 0) return null;
    return (
      <Section id={ANCHOR.internal} title={<GroupTitle title={t(GROUP_TITLE.internal)} n={rows.length} />} testId="page-internal">
        <RowList label={t(GROUP_TITLE.internal)}>
          {rows.map((r) => (
            <RowItem key={r.issueKey} wrap dim title={r.title} facts={[t(`releases.page.internal.${r.why}`)]} trailing={<span className="font-mono text-12 text-subtle">{r.issueKey}</span>} testId="page-internal-row" rowKey={r.issueKey} />
          ))}
        </RowList>
      </Section>
    );
  }
  const lines = [
    ...(glance.internal > 0 ? [t(glance.internal === 1 ? "releases.page.internal.one" : "releases.page.internal.many", { n: glance.internal })] : []),
    ...(glance.other > 0 ? [`${t(glance.other === 1 ? "releases.page.unnoted.one" : "releases.page.unnoted.many", { n: glance.other })}.`] : []),
  ];
  if (lines.length === 0) return null;
  return (
    <p className="flex flex-wrap items-baseline gap-x-2 border-t border-line-subtle pt-3 text-14 text-muted" data-testid="page-internal-line" data-internal={glance.internal} data-unnoted={glance.other}>
      {lines.map((l) => (
        <span key={l}>{l}</span>
      ))}
      {reach.slug ? (
        <Link href="?view=developer" className="text-link hover:underline" data-testid="page-internal-see">
          {t("releases.page.internal.see")}
        </Link>
      ) : null}
    </p>
  );
}

/** The groups the page draws, in reading order, so its contents name exactly what is on it. */
function shownGroups(page: ReleasePage, glance: ReleaseGlance): Anchor[] {
  const developer = page.view === "developer";
  return [
    ...(page.highlights.state === "none" ? [] : (["highlights"] as const)),
    ...(page.actionRequired.length > 0 ? (["admin"] as const) : []),
    ...RELEASE_CHANGE_GROUPS.filter((g) => glance.groups[g].length > 0),
    ...(developer && (page.internal.changes?.length ?? 0) > 0 ? (["internal"] as const) : []),
    ...(developer && page.requirements.length > 0 ? (["requirements"] as const) : []),
    ...(developer && page.knownIssues.length > 0 ? (["open"] as const) : []),
    ...(developer && page.withoutNotes.length > 0 ? (["other"] as const) : []),
    ...(page.technical ? (["technical"] as const) : []),
  ];
}

/**
 * The page's contents: one item per group it draws, each naming the anchor the group starts at, then
 * the sections drawn after it (`record`), so a page has one navigation.
 */
export function useReleaseContents(page: ReleasePage | undefined, after: ContentsItem[] = []): ContentsItem[] {
  const t = useCopy();
  if (!page) return [];
  return [
    ...shownGroups(page, releaseGlanceOf(page)).map((a) => ({
      id: ANCHOR[a],
      label: a === "highlights" ? t("releases.page.highlights.title") : t(GROUP_TITLE[a]),
    })),
    ...after,
  ];
}

/** Sections a page draws after its own, with the contents entries that name them. */
export interface PageRecord {
  contents: ContentsItem[];
  node: ReactNode;
}

/**
 * `slug` is set where the reader is a member in the app (keys link into the project); `authed` says
 * the media are issue attachments behind the session rather than tickets a share link minted, and
 * that a row may read its technical note. `railContents` says a facts rail beside the page lists the
 * contents on a wide screen, so the menu here shows only where that rail has collapsed. `record` is
 * what the page draws after its own sections, named in the same contents.
 */
export function ReleaseReader({
  page,
  slug,
  authed,
  railContents = false,
  record,
}: {
  page: ReleasePage;
  slug?: string | undefined;
  authed: boolean;
  railContents?: boolean;
  record?: PageRecord | undefined;
}) {
  const t = useCopy();
  const contents = useReleaseContents(page, record?.contents);
  const glance = releaseGlanceOf(page);
  const checks = checksByIssue(page);
  const reach: Reach = { slug, authed };
  const developer = page.view === "developer";
  return (
    <div className="grid gap-6" data-testid="release-reader" data-view={page.view} data-tour="rel-users">
      <ContentsMenu items={contents} label={t("releases.page.contents")} testId="page-contents" className={railContents ? "-mb-4 lg:hidden" : "-mb-4"} />
      <div className="grid gap-3" data-testid="page-header" data-state={page.header.state} data-approval={page.header.approval.state}>
        <ReleaseSummary page={page} />
        <ReleaseTally glance={glance} />
      </div>
      {/* the summary and the tally are this page's lead: below 1024px the rail follows them */}
      <DetailLeadEnd inset />
      {/* each group's list ends on a hairline; a second one over the next group's title would box it */}
      <div className="grid [&>section]:border-t-0">
        <div id={ANCHOR.highlights} className="scroll-mt-24 pt-5 empty:hidden">
          <ReleaseHighlightList highlights={page.highlights} slug={slug} authed={authed} />
        </div>
        <BeforeYouRelease page={page} />
        {RELEASE_CHANGE_GROUPS.map((g) => (
          <ChangeGroup key={g} group={g} rows={glance.groups[g]} page={page} checks={checks} reach={reach} />
        ))}
        <InternalChanges page={page} glance={glance} reach={reach} />
        {developer ? (
          <>
            <Requirements page={page} slug={slug} />
            <StillOpen page={page} reach={reach} />
            <OtherChanges page={page} reach={reach} />
          </>
        ) : null}
        <Technical page={page} slug={slug} />
      </div>
      {record?.node}
    </div>
  );
}
