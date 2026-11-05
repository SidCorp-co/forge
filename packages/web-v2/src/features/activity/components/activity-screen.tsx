// The workspace's Activity tab (ISS-951; ISS-979, the owner's mockup v3): one lane per project over
// its last two hours, in core's groups (Waiting on you first, then Working, Idle, Paused, No master),
// each group the shared hierarchy with its lanes indented under it. The chips filter by group and
// count projects, the same unit as the groups; the switch shows batches of status moves or releases
// only; the legend names each mark. A lane opens its peek for the rest (Now, Backlog, People, the
// releases, Recent). The org's room keeps it live, and the last answer stays on screen while it reads again.

import { ORG_ACTIVITY_GROUPS, type OrgActivity, type OrgActivityGroup } from "@forge/contracts/org-activity";
import type { ReactNode } from "react";
import {
  EmptyState,
  FilterChip,
  type LegendTone,
  ListLayout,
  ListToolbar,
  PageTitle,
  rememberListOrigin,
  SegmentedControl,
  TimelineGlyph,
  TimelineLegend,
  TimelineRunSwatch,
  TopBarActions,
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

/** Each group's tone: its dot, and amber for the one that needs the reader. */
const GROUP_TONE: Record<OrgActivityGroup, LegendTone> = { you: "you", working: "run", idle: "blocked", paused: "neutral", none: "err" };

type Show = "all" | OrgActivityGroup;
const SHOWS: readonly Show[] = ["all", ...ORG_ACTIVITY_GROUPS];
type View = "batches" | "releases";

function groupsOf(data: OrgActivity, show: Show, t: Copy): LaneGroup[] {
  return ORG_ACTIVITY_GROUPS.filter((g) => show === "all" || show === g).map((g) => ({
    id: g,
    label: t(`activity.group.${g}`),
    tone: GROUP_TONE[g],
    rows: data.projects.filter((r) => r.group === g),
  }));
}

/** The chips: All and each group that holds a project, each counting projects; Waiting on you in amber. */
function Strip({ totals, show, onShow, t }: { totals: OrgActivity["totals"]; show: Show; onShow: (s: Show) => void; t: Copy }) {
  return (
    <ListToolbar testId="activity-strip">
      {SHOWS.filter((s) => s === "all" || totals[s] > 0).map((s) => (
        <FilterChip
          key={s}
          on={show === s}
          onToggle={() => onShow(s === show ? "all" : s)}
          count={s === "all" ? totals.projects : totals[s]}
          tone={s === "you" ? "you" : undefined}
          fill={s === "you"}
          testId={`activity-show-${s}`}
        >
          {s === "all" ? t("activity.show.all") : t(`activity.group.${s}`)}
        </FilterChip>
      ))}
    </ListToolbar>
  );
}

/** What each mark means; the batch's only while batches are shown. */
function Legend({ view, t }: { view: View; t: Copy }) {
  const items = [
    { key: "you", swatch: <TimelineGlyph shape={{ kind: "pin", n: 0 }} small />, label: t("activity.legend.you") },
    { key: "released", swatch: <TimelineGlyph shape={{ kind: "diamond", tone: "ok" }} small />, label: t("activity.legend.released") },
    { key: "releasing", swatch: <TimelineGlyph shape={{ kind: "diamond", tone: "info" }} small />, label: t("activity.legend.releasing") },
    { key: "failed", swatch: <TimelineGlyph shape={{ kind: "diamond", tone: "danger" }} small />, label: t("activity.legend.failed") },
    ...(view === "batches" ? [{ key: "batch", swatch: <TimelineGlyph shape={{ kind: "count", n: 3 }} small />, label: t("activity.legend.batch") }] : []),
    { key: "run", swatch: <TimelineRunSwatch />, label: t("activity.legend.run") },
  ];
  return <TimelineLegend items={items} />;
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

function ActivityList({ data, orgId, view }: { data: OrgActivity; orgId: string; view: View }) {
  const t = useCopy();
  const router = useRouter();
  const now = useNowSeconds();
  const [params, setParams] = useUrlParams();
  const raw = params.get("show");
  const show: Show = (SHOWS as readonly string[]).includes(raw ?? "") ? (raw as Show) : "all";
  const fold = useGroupFold("web-v2:activity-fold");
  const groups = groupsOf(data, show, t);
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
        <Legend view={view} t={t} />
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
            batches={view === "batches"}
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

/** Batches of status moves, or releases only: kept in the URL as `?view=releases`. */
function ViewSwitch({ view, onView, t }: { view: View; onView: (v: View) => void; t: Copy }) {
  return (
    <TopBarActions>
      <span role="group" aria-label={t("activity.view.label")} data-testid="activity-view">
        <SegmentedControl<View>
          value={view}
          onChange={onView}
          options={[
            { value: "batches", label: t("activity.view.batches") },
            { value: "releases", label: t("activity.view.releases") },
          ]}
        />
      </span>
    </TopBarActions>
  );
}

/** The time a page's "N s ago" reads against, moving each second so a silent box is seen to go silent. */
const useNowSeconds = (): number => useNow(1_000);

export function ActivityScreen(): ReactNode {
  const t = useCopy();
  const { activeOrgId } = useActiveOrg();
  const q = useOrgActivity(activeOrgId);
  const [params, setParams] = useUrlParams();
  const view: View = params.get("view") === "releases" ? "releases" : "batches";
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
          <ViewSwitch view={view} onView={(v) => setParams({ view: v === "batches" ? null : v })} t={t} />
          <ActivityList data={data} orgId={activeOrgId} view={view} />
        </div>
      )}
    </QueryBoundary>
  );
}
