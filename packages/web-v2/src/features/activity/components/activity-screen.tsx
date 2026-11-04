// The workspace's Activity tab (ISS-951; MK-10 C, the timeline the owner chose): one lane per project
// over its last two hours, grouped where core put it (Running · Idle with backlog · Waiting on a
// person · Quiet), with its name and what it does on the left and its pane badge and how fresh that
// is on the right. The strip filters it; a lane opens its peek for the rest (Now, Backlog, People, the
// releases, Recent). The org's room keeps it live, and the last answer stays on screen while it reads again.

import { ORG_ACTIVITY_GROUPS, type OrgActivity, type OrgActivityGroup, type OrgActivityProject } from "@forge/contracts/org-activity";
import type { ReactNode } from "react";
import {
  EmptyState,
  FilterChip,
  type LegendTone,
  ListLayout,
  ListToolbar,
  PageTitle,
  rememberListOrigin,
  useGroupFold,
  useNow,
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
import { ActivityPeek } from "./activity-peek";
import { ActivityLanes, type LaneGroup } from "./lanes";

export const ACTIVITY_LIST = "/activity";
export const projectHref = (slug: string) => `/projects/${encodeURIComponent(slug)}`;

const GROUP_TONE: Record<OrgActivityGroup, LegendTone> = { running: "run", idle: "ready", waiting: "you", quiet: "neutral" };

/** The strip's filters: each names the rows it keeps and the total core counted for it. */
const SHOWS = ["all", "running", "queued", "people", "release", "noMaster"] as const;
type Show = (typeof SHOWS)[number];

const keeps: Record<Show, (p: OrgActivityProject) => boolean> = {
  all: () => true,
  running: (p) => p.group === "running",
  queued: (p) => p.next.total > 0,
  people: (p) => p.people.total > 0,
  release: (p) => p.awaitingRelease > 0,
  noMaster: (p) => p.master.state === "none",
};

const countOf = (totals: OrgActivity["totals"], show: Show): number =>
  ({ all: totals.projects, running: totals.running, queued: totals.queued, people: totals.people, release: totals.awaitingRelease, noMaster: totals.noMaster })[show];

const SHOW_TONE: Partial<Record<Show, LegendTone>> = { running: "run", people: "you", release: "ready" };

function groupsOf(rows: OrgActivityProject[], t: Copy): LaneGroup[] {
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

function Live({ at, updating }: { at: string; updating: boolean }) {
  const locale = useCopyLocale();
  const t = useCopy();
  const time = new Date(at).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
  return (
    <span className="inline-flex items-center gap-1.5 text-12 text-subtle" data-testid="activity-live">
      <span aria-hidden className="size-1.5 rounded-full bg-ok-9" />
      <span className="sr-only">{t("activity.live")}</span>
      {time}
      <span aria-live="polite" className={cn("text-11-5 transition-opacity", updating ? "opacity-100" : "opacity-0")} data-testid="activity-updating">
        {updating ? t("activity.updating") : ""}
      </span>
    </span>
  );
}

function ActivityList({ data, orgId }: { data: OrgActivity; orgId: string }) {
  const t = useCopy();
  const router = useRouter();
  const now = useNowSeconds();
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
    <ListLayout peek={open ? <ActivityPeek key={open.slug} row={open} orgId={orgId} peek={peek} now={now} full={{ href: projectHref(open.slug), origin: ACTIVITY_LIST }} /> : undefined}>
      <div className="min-w-0">
        <Strip totals={data.totals} show={show} onShow={(s) => setParams({ show: s === "all" ? null : s })} t={t} />
        {data.projects.length === 0 ? (
          <div className="px-5 py-10">
            <EmptyState message={t("activity.empty")} />
          </div>
        ) : (
          <ActivityLanes
            ariaLabel={t("activity.title")}
            groups={groups}
            fold={fold}
            generatedAt={data.generatedAt}
            now={now}
            hrefOf={projectHref}
            selected={peek.open}
            onPeek={(k) => peek.set(k === peek.open ? null : k)}
            empty={t("activity.noMatch")}
          />
        )}
      </div>
    </ListLayout>
  );
}

/** The time a page's "N s ago" reads against, moving each second so a silent box is seen to go silent. */
const useNowSeconds = (): number => useNow(1_000);

export function ActivityScreen(): ReactNode {
  const t = useCopy();
  const { activeOrgId } = useActiveOrg();
  const q = useOrgActivity(activeOrgId);
  const updating = q.isFetching && !q.isLoading;
  const title = (live?: string) => <PageTitle after={live ? <Live at={live} updating={updating} /> : undefined}>{t("activity.title")}</PageTitle>;
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
          <ActivityList data={data} orgId={activeOrgId} />
        </div>
      )}
    </QueryBoundary>
  );
}
