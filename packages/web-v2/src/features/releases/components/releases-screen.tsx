// The Releases list in the shape the owner approved (ISS-1001, `approval-report-template`): three
// groups (waiting on you, going to production, in production with the last few shown), one row per
// release with its one proof bar, the short tags of what needs attention, and its one act; a release
// a later one carries folds into one line under it (`release-list.ts`). The chat's narrowing still
// applies (REQ-41 BC-5): whom a release waits on and its state.

import type { ReleaseLanding } from "@forge/contracts/releases";
import { matchesListFilter, waitingFilterOf } from "@forge/contracts/ui-list-filters";
import { useState } from "react";
import { ListFilterBar, useListNarrowing } from "@/features/chat-dock";
import { EmptyState, GROUP_ROW_INDENT, GroupHeader, ListPage, PageTitle, useGroupFold } from "@/design";
import { useReportShown } from "@/design/hooks/use-page-shown";
import { QueryBoundary } from "@/lib/api/query-boundary";
import { useCopy, useTimeFormat } from "@/lib/i18n/interface-language";
import type { Copy } from "@/lib/i18n/product-copy";
import { Link } from "@/lib/navigation/router";
import { releaseHref } from "@/lib/routes/releases";
import { cn } from "@/lib/utils/cn";
import { useReleases } from "../hooks";
import { releaseProofOf, unprovenOf } from "../proof";
import { type ReleaseLine, releaseListOf, versionsOf } from "../release-list";
import type { ReleaseSummary } from "../types";
import { ReleaseVersion } from "./release-bits";
import { ReleaseProofBar, type ReleaseTag, ReleaseTags } from "./release-proof";

/** What needs the decider's attention on a row, in two words each. */
export function listTagsOf(r: ReleaseSummary, t: Copy): ReleaseTag[] {
  const unproven = unprovenOf(releaseProofOf(r.verified));
  return [
    ...(unproven > 0 ? [{ key: "unproven", text: t("releases.tag.unproven", { n: unproven }), tone: "warn" as const }] : []),
    ...(r.shippedFailing ? [{ key: "failing", text: t("releases.tag.failing", { n: r.shippedFailing.count }), tone: "warn" as const }] : []),
    ...(r.attentionGroup === "stuck" ? [{ key: "stuck", text: t("releases.tag.stuck"), tone: "warn" as const }] : []),
  ];
}

/** The one act a row offers its reader: open the page where they decide or cut it. */
const actOf = (r: ReleaseSummary, t: Copy): string => t(r.state === "draft" && !r.can.decide ? "releases.review.cut" : "releases.review.approve");

const ROW = cn("relative flex min-h-14 items-center gap-4 border-b border-line-divider py-3 pr-5 hover:bg-hover max-md:flex-wrap max-md:pr-3", GROUP_ROW_INDENT);

/** A version whose hyphens never break a line: U+2011, the non-breaking hyphen. */
const unbroken = (version: string) => version.replaceAll("-", "\u2011");

function Carried({ carries, slug }: { carries: readonly ReleaseSummary[]; slug: string }) {
  const t = useCopy();
  const [open, setOpen] = useState(false);
  if (carries.length === 0) return null;
  const newest = carries[0];
  const oldest = carries[carries.length - 1];
  // inside the sentence a version keeps its hyphens unbroken, as `ReleaseVersion` keeps it whole
  const said =
    carries.length === 1
      ? t("releases.carries.one", { v: unbroken(newest.version) })
      : t("releases.carries.many", { n: carries.length, from: unbroken(oldest.version), to: unbroken(newest.version) });
  return (
    <div className={cn("border-b border-line-divider py-2.5 pr-5 text-13 text-muted", GROUP_ROW_INDENT)} data-testid="release-carries" data-n={carries.length}>
      <span>{said}</span>
      <button type="button" className="ml-2 font-medium text-link hover:underline" aria-expanded={open} onClick={() => setOpen((o) => !o)} data-testid="release-carries-toggle">
        {t(open ? "releases.hide" : "releases.show")}
      </button>
      {open ? (
        <ul className="mt-2 grid gap-1">
          {carries.map((c) => (
            <li key={c.version} data-testid="release-carried" data-key={c.version}>
              <Link href={releaseHref(slug, c.version)} className="text-fg hover:text-link hover:underline">
                <ReleaseVersion version={c.version} />
                {c.name ? <span className="ml-2">{c.name}</span> : null}
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function ReleaseLineView({ line, slug, acts }: { line: ReleaseLine; slug: string; acts: boolean }) {
  const t = useCopy();
  const time = useTimeFormat();
  const r = line.release;
  const shipped = r.state === "shipped";
  const when = shipped && r.releasedAt ? time.date(r.releasedAt) : time.relative(r.at);
  return (
    <>
      <div className={ROW} data-testid="list-row" data-key={r.version} data-state={r.state}>
        <span className="grid min-w-0 flex-1 gap-1.5">
          {/* the row is one link to the page; its act sits above that link */}
          <Link href={releaseHref(slug, r.version)} className="flex min-w-0 items-baseline gap-2 text-fg after:absolute after:inset-0" data-testid="release-row-link">
            <ReleaseVersion version={r.version} className="text-14 font-semibold" />
            {r.name ? <span className="truncate text-14 font-medium">{r.name}</span> : null}
          </Link>
          {shipped ? null : <ReleaseProofBar proof={releaseProofOf(r.verified)} issues={r.issueCount} />}
          <ReleaseTags tags={listTagsOf(r, t)} />
        </span>
        <span className="relative z-1 flex items-center gap-3">
          <span className="text-12 text-muted tabular-nums" title={time.dateTime(r.at)}>
            {when}
          </span>
          {acts ? (
            <Link href={releaseHref(slug, r.version)} className="rounded-md bg-accent px-3 py-1.5 text-13 font-medium text-on-accent hover:opacity-90" data-testid="release-row-act">
              {actOf(r, t)}
            </Link>
          ) : null}
        </span>
      </div>
      <Carried carries={line.carries} slug={slug} />
    </>
  );
}

function Older({ lines, landings, slug }: { lines: readonly ReleaseLine[]; landings: readonly ReleaseLanding[]; slug: string }) {
  const t = useCopy();
  const time = useTimeFormat();
  const [open, setOpen] = useState(false);
  const n = lines.length + landings.length;
  if (n === 0) return null;
  return (
    <>
      <div className={cn("border-b border-line-divider py-2.5 pr-5 text-13 text-muted", GROUP_ROW_INDENT)} data-testid="release-older" data-n={n}>
        <button type="button" className="font-medium text-link hover:underline" aria-expanded={open} onClick={() => setOpen((o) => !o)} data-testid="release-older-toggle">
          {t("releases.older", { n })}
        </button>
      </div>
      {open ? (
        <>
          {lines.map((l) => (
            <ReleaseLineView key={l.release.version} line={l} slug={slug} acts={false} />
          ))}
          {landings.map((l) => (
            <div key={l.runId} className={cn("border-b border-line-divider py-2.5 pr-5 text-13 text-muted", GROUP_ROW_INDENT)} data-testid="release-landing">
              {t("releases.landings.title")} · <span className="font-mono">{l.branch}</span> · {time.date(l.at)}
            </div>
          ))}
        </>
      ) : null}
    </>
  );
}

type GroupId = "you" | "going" | "production";

const GROUP_TONE = { you: "you", going: "run", production: "done" } as const;

function Group({ id, count, children, empty }: { id: GroupId; count: number; children: React.ReactNode; empty?: string }) {
  const t = useCopy();
  const fold = useGroupFold("web-v2:releases-groups");
  const open = fold.isOpen(id);
  return (
    <div data-testid="release-group" data-group={id}>
      <GroupHeader id={id} label={t(`releases.group.${id}`)} count={count} tone={GROUP_TONE[id]} open={open} onToggle={() => fold.toggle(id)} />
      {open ? (count === 0 && empty ? <p className={cn("border-b border-line-divider py-2.5 text-13 text-muted", GROUP_ROW_INDENT)}>{empty}</p> : children) : null}
    </div>
  );
}

export function ReleasesScreen({ projectId, slug }: { projectId: string; slug: string }) {
  const t = useCopy();
  const q = useReleases(projectId);
  // whom a release waits on and its state are the list filter the chat sets too (REQ-41 BC-5)
  const filter = useListNarrowing("releases");
  const all = q.data?.releases ?? [];
  const narrow = (l: ReleaseLine) => matchesListFilter(filter, { waiting: waitingFilterOf(l.release), text: "", state: l.release.state });
  const list = releaseListOf(all);
  const you = list.you.filter(narrow);
  const going = list.going.filter(narrow);
  const production = list.production.filter(narrow);
  const older = list.older.filter(narrow);
  useReportShown(versionsOf([...you, ...going, ...production]));

  return (
    <QueryBoundary query={q} loadingLabel={t("releases.loadingList")} title={<PageTitle>{t("releases.title")}</PageTitle>} height="60vh" retry="always">
      {({ production: path, landings }) => (
        <ListPage
          testId="releases-screen"
          title={t("releases.title")}
          toolbar={
            <>
              <ListFilterBar list="releases" />
              {path.ok ? null : (
                <span className="text-12 text-muted" title={path.reason} data-testid="production-unreadable">
                  {t("releases.productionUnreadable")}
                </span>
              )}
            </>
          }
        >
          {all.length === 0 && (landings ?? []).length === 0 ? (
            <div className="px-5 py-10">
              <EmptyState message={t("releases.emptyTitle")} />
            </div>
          ) : (
            <section aria-label={t("releases.title")} data-testid="release-list">
              <Group id="you" count={you.length}>
                {you.map((l) => (
                  <ReleaseLineView key={l.release.version} line={l} slug={slug} acts />
                ))}
              </Group>
              <Group id="going" count={going.length} empty={t("releases.group.goingEmpty")}>
                {going.map((l) => (
                  <ReleaseLineView key={l.release.version} line={l} slug={slug} acts={false} />
                ))}
              </Group>
              <Group id="production" count={production.length + older.length}>
                {production.map((l) => (
                  <ReleaseLineView key={l.release.version} line={l} slug={slug} acts={false} />
                ))}
                <Older lines={older} landings={landings ?? []} slug={slug} />
              </Group>
            </section>
          )}
        </ListPage>
      )}
    </QueryBoundary>
  );
}
