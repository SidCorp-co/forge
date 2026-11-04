// The workspace's Activity tab (ISS-951, mockup MK-8): one row per project, grouped where core put it
// (Working · Idle with work · Waiting · Quiet), with its master's standing, counts of what is in flight,
// queued and waiting on people, its next release's progress and what waits for a release. Names,
// counts and badges only; a row opens its peek for the rest. The org's room keeps it live.

import { ORG_ACTIVITY_GROUPS, type OrgActivity, type OrgActivityGroup, type OrgActivityProject } from "@forge/contracts/org-activity";
import type { ReactNode } from "react";
import {
  EmptyState,
  FilterChip,
  GroupedList,
  type LegendTone,
  type ListGroup,
  ListLayout,
  type ListRowView,
  ListToolbar,
  PageTitle,
  rememberListOrigin,
  StatusBadge,
  useGroupFold,
  usePeek,
  usePeekKeys,
  useUrlParams,
  visibleRows,
} from "@/design";
import { useActiveOrg } from "@/features/orgs";
import { QueryBoundary } from "@/lib/api/query-boundary";
import { useCopy, useCopyLocale } from "@/lib/i18n/interface-language";
import type { Copy } from "@/lib/i18n/product-copy";
import { useRouter } from "@/lib/navigation/router";
import { cn } from "@/lib/utils/cn";
import { useOrgActivity } from "../hooks";
import { ActivityPeek, ReleaseBar } from "./activity-peek";

export const ACTIVITY_LIST = "/activity";
export const projectHref = (slug: string) => `/projects/${encodeURIComponent(slug)}`;

const GROUP_TONE: Record<OrgActivityGroup, LegendTone> = { working: "run", idle: "ready", waiting: "you", quiet: "neutral" };

/** The strip's filters: each names the rows it keeps and the total core counted for it. */
const SHOWS = ["all", "inFlight", "queued", "people", "release", "noMaster"] as const;
type Show = (typeof SHOWS)[number];

const keeps: Record<Show, (p: OrgActivityProject) => boolean> = {
  all: () => true,
  inFlight: (p) => p.now.length > 0,
  queued: (p) => p.next.total > 0,
  people: (p) => p.people.total > 0,
  release: (p) => p.awaitingRelease > 0,
  noMaster: (p) => p.master.state === "none",
};

const countOf = (totals: OrgActivity["totals"], show: Show): number =>
  ({ all: totals.projects, inFlight: totals.inFlight, queued: totals.queued, people: totals.people, release: totals.awaitingRelease, noMaster: totals.noMaster })[show];

const SHOW_TONE: Partial<Record<Show, LegendTone>> = { inFlight: "run", people: "you", release: "ready" };

function Count({ n, label, tone }: { n: number; label: string; tone?: LegendTone }) {
  return (
    <span className="inline-flex items-baseline gap-1" aria-label={`${label} ${n}`}>
      <span aria-hidden className="text-11-5 text-subtle md:hidden">{label}</span>
      {n > 0 ? (
        <span aria-hidden className={cn("font-mono text-12-5 font-semibold tabular-nums", tone === "run" ? "text-link" : "text-fg")}>
          {n}
        </span>
      ) : (
        <span aria-hidden className="text-subtle">—</span>
      )}
    </span>
  );
}

function rowOf(t: Copy) {
  return (p: OrgActivityProject): ListRowView => ({
    key: p.slug,
    href: projectHref(p.slug),
    title: p.name,
    facts: [],
    state: <StatusBadge family="masterState" value={p.master.state} />,
    waitingOn: (
      <span className="grid w-full max-w-52 grid-cols-3 gap-2" data-testid="activity-counts">
        <Count n={p.now.length} label={t("activity.col.now")} tone="run" />
        <Count n={p.next.total} label={t("activity.col.next")} />
        <Count n={p.people.total} label={t("activity.col.people")} />
      </span>
    ),
    owner: p.release ? <ReleaseBar release={p.release} /> : <span className="text-subtle">—</span>,
    age: p.awaitingRelease > 0 ? { text: String(p.awaitingRelease), title: t("activity.approveHint", { n: p.awaitingRelease }) } : null,
  });
}

function groupsOf(rows: OrgActivityProject[], t: Copy): ListGroup<OrgActivityProject>[] {
  return ORG_ACTIVITY_GROUPS.map((g) => ({ id: g, label: t(`activity.group.${g}`), tone: GROUP_TONE[g], rows: rows.filter((r) => r.group === g) }));
}

function Strip({ totals, show, onShow, t }: { totals: OrgActivity["totals"]; show: Show; onShow: (s: Show) => void; t: Copy }) {
  return (
    <ListToolbar testId="activity-strip">
      {SHOWS.map((s) => (
        <FilterChip key={s} on={show === s} onToggle={() => onShow(s === show ? "all" : s)} count={countOf(totals, s)} tone={SHOW_TONE[s]} testId={`activity-show-${s}`}>
          {t(`activity.show.${s}`)}
        </FilterChip>
      ))}
    </ListToolbar>
  );
}

function Live({ at }: { at: string }) {
  const locale = useCopyLocale();
  const t = useCopy();
  const time = new Date(at).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
  return (
    <span className="inline-flex items-center gap-1.5 text-12 text-subtle" title={t("activity.liveHint")} data-testid="activity-live">
      <span aria-hidden className="size-1.5 rounded-full bg-ok-9" />
      {time}
    </span>
  );
}

function ActivityList({ data }: { data: OrgActivity }) {
  const t = useCopy();
  const router = useRouter();
  const [params, setParams] = useUrlParams();
  const raw = params.get("show");
  const show: Show = (SHOWS as readonly string[]).includes(raw ?? "") ? (raw as Show) : "all";
  const fold = useGroupFold("web-v2:activity-fold");
  const rows = data.projects.filter(keeps[show]);
  const groups = groupsOf(rows, t);
  const visible = visibleRows(groups, fold).map((r) => r.slug);
  const peek = usePeek(visible, data.projects.map((p) => p.slug));
  const open = peek.open ? data.projects.find((p) => p.slug === peek.open) : undefined;
  const openFull = (slug: string) => {
    rememberListOrigin(ACTIVITY_LIST);
    router.push(projectHref(slug));
  };
  usePeekKeys(peek, openFull);

  return (
    <ListLayout peek={open ? <ActivityPeek key={open.slug} row={open} peek={peek} full={{ href: projectHref(open.slug), origin: ACTIVITY_LIST }} /> : undefined}>
      <div className="min-w-0">
        <Strip totals={data.totals} show={show} onShow={(s) => setParams({ show: s === "all" ? null : s })} t={t} />
        {data.projects.length === 0 ? (
          <div className="px-5 py-10">
            <EmptyState message={t("activity.empty")} />
          </div>
        ) : (
          <GroupedList
            ariaLabel={t("activity.title")}
            groups={groups}
            fold={fold}
            row={rowOf(t)}
            selected={peek.open}
            onPeek={(k) => peek.set(k === peek.open ? null : k)}
            empty={t("activity.noMatch")}
            keyColumn={false}
            columns={{ title: t("activity.col.project"), state: t("activity.col.master"), waitingOn: t("activity.col.counts"), meta: t("activity.col.release") }}
          />
        )}
      </div>
    </ListLayout>
  );
}

export function ActivityScreen(): ReactNode {
  const t = useCopy();
  const { activeOrgId } = useActiveOrg();
  const q = useOrgActivity(activeOrgId);
  const title = (live?: string) => <PageTitle after={live ? <Live at={live} /> : undefined}>{t("activity.title")}</PageTitle>;
  if (!activeOrgId) {
    return (
      <div className="grid min-h-full content-start bg-app" data-testid="activity-screen">
        {title()}
        <div className="px-5 py-10">
          <EmptyState message={t("activity.noOrg")} />
        </div>
      </div>
    );
  }
  return (
    <QueryBoundary query={q} loadingLabel={t("activity.loading")} title={title()} height="60vh" retry="always">
      {(data) => (
        <div className="grid min-h-full content-start bg-app" data-testid="activity-screen">
          {title(data.generatedAt)}
          <ActivityList data={data} />
        </div>
      )}
    </QueryBoundary>
  );
}
