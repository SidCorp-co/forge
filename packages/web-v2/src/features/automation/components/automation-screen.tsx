"use client";

// Development > Automation (ISS-116, prototype #/dev/automation, design automation rev 1 step
// screen): one area with tabs Schedules, Fires and Reports (`?tab=`), each the shared GroupedList with
// Needs you first, a peek (`?peek=`) and a full page per row, all read from GET /automation/standing
import {
  FIRE_GROUPS,
  FIRE_GROUP_LABELS,
  REPORT_GROUPS,
  REPORT_GROUP_LABELS,
  SCHEDULE_GROUPS,
  SCHEDULE_GROUP_LABELS,
} from "@forge/contracts/automation-standing";
import { useRouter } from "next/navigation";
import { useCallback, useMemo, useState } from "react";
import {
  Button,
  GroupedList,
  type ListGroup,
  ListSearch,
  PageTitle,
  rememberListOrigin,
  standingGroups,
  Tabs,
  useGroupFold,
  usePeek,
  usePeekKeys,
  useUrlParams,
  useUrlTab,
  visibleRows,
} from "@/design";
import { QueryBoundary } from "@/lib/api/query-boundary";
import { useCreateSchedule } from "@/features/automation/schedule-hooks";
import { cn } from "@/lib/utils/cn";
import { useAutomationStanding } from "../hooks";
import { AUTOMATION_LIST, AUTOMATION_TABS, type AutomationTab, fireHref, reportHref, scheduleHref } from "@/lib/routes/automation";
import type { AutomationStandingResponse, FireStanding, ReportStanding, ScheduleStanding } from "../types";
import { FirePeek, fireRow } from "./fire-views";
import { ReportPeek, reportRow } from "./report-views";
import { ScheduleForm } from "./schedule-form";
import { type AutomationAccess, SchedulePeek, scheduleRow } from "./schedule-views";

const matches = (text: string, ...parts: Array<string | null | undefined>) =>
  !text || parts.join(" ").toLowerCase().includes(text);

function tabRows(d: AutomationStandingResponse, tab: AutomationTab, text: string) {
  if (tab === "schedules") {
    const rows = d.schedules.filter((s) => matches(text, s.name, s.targetProjectSlug, s.owner?.name));
    return standingGroups(rows, SCHEDULE_GROUPS, SCHEDULE_GROUP_LABELS) as ListGroup<ScheduleStanding | FireStanding | ReportStanding>[];
  }
  if (tab === "fires") {
    const rows = d.fires.filter((f) => matches(text, f.id, f.scheduleName));
    return standingGroups(rows, FIRE_GROUPS, FIRE_GROUP_LABELS) as ListGroup<ScheduleStanding | FireStanding | ReportStanding>[];
  }
  const rows = d.reports.filter((r) => matches(text, r.id, r.summary, r.fire?.scheduleName, r.targetRef));
  return standingGroups(rows, REPORT_GROUPS, REPORT_GROUP_LABELS) as ListGroup<ScheduleStanding | FireStanding | ReportStanding>[];
}

const COLUMNS: Record<AutomationTab, { key: string; title: string; state: string; waitingOn: string; meta: string }> = {
  schedules: { key: "Schedule", title: "What it runs", state: "State", waitingOn: "Waiting on", meta: "Owner · last fire" },
  fires: { key: "Fire", title: "Schedule", state: "Result", waitingOn: "Waiting on", meta: "By · age" },
  reports: { key: "Report", title: "Summary", state: "Triage", waitingOn: "Waiting on", meta: "From · age" },
};

const NOUN: Record<AutomationTab, string> = { schedules: "schedules", fires: "fires", reports: "reports" };

export function AutomationScreen({ access }: { access: AutomationAccess }) {
  const { projectId, slug } = access;
  const q = useAutomationStanding(projectId);
  const create = useCreateSchedule(projectId);
  const [creating, setCreating] = useState(false);
  const router = useRouter();
  const [tab, setTab] = useUrlTab(AUTOMATION_TABS);
  const [params, setParams] = useUrlParams();
  const text = (params.get("q") ?? "").trim().toLowerCase();
  const fold = useGroupFold(`web-v2:automation-fold:${tab}`);
  const d = q.data;
  const groups = useMemo(() => (d ? tabRows(d, tab, text) : []), [d, tab, text]);
  const visible = useMemo(() => visibleRows(groups, fold).map((r) => r.id), [groups, fold]);
  const allKeys = useMemo(() => groups.flatMap((g) => g.rows.map((r) => r.id)), [groups]);
  const peek = usePeek(visible, allKeys);

  const hrefOf = useMemo(
    () => ({
      schedules: (id: string) => scheduleHref(slug, id),
      fires: (id: string) => fireHref(slug, id),
      reports: (id: string) => reportHref(slug, id),
    }),
    [slug],
  );
  const openFull = useCallback(
    (key: string) => {
      rememberListOrigin(AUTOMATION_LIST);
      router.push(hrefOf[tab](key));
    },
    [router, hrefOf, tab],
  );
  usePeekKeys(peek, openFull);

  const title = <PageTitle hint="What fires, what each fire produced, and what needs a person.">Automation</PageTitle>;
  return (
    <QueryBoundary query={q} loadingLabel="loading automation…" title={title} height="60vh" retry="always">
      {(d) => {
        const tabs = [
          { value: "schedules", label: "Schedules", count: d.schedules.length },
          { value: "fires", label: "Fires", count: d.firesTotal },
          { value: "reports", label: "Reports", count: d.reportCounts.new },
        ];
        const row = (r: ScheduleStanding | FireStanding | ReportStanding) =>
          tab === "schedules"
            ? scheduleRow(hrefOf.schedules)(r as ScheduleStanding)
            : tab === "fires"
              ? fireRow(hrefOf.fires)(r as FireStanding)
              : reportRow(hrefOf.reports)(r as ReportStanding);
        const open = peek.open ? groups.flatMap((g) => g.rows).find((r) => r.id === peek.open) : undefined;
        const scheduleOf = (id: string) => d.schedules.find((s) => s.id === id);

        return (
          <div className="grid min-h-full content-start bg-app" data-testid="automation-screen">
            {title}
            <div className="border-b border-line-subtle px-5 max-md:px-2" data-testid="automation-tabs">
              <Tabs tabs={tabs} value={tab} onChange={(t) => setTab(t as AutomationTab)} />
            </div>
            <div className={cn("grid min-h-[60vh] items-start", open && "lg:grid-cols-[minmax(0,1fr)_minmax(380px,440px)]")}>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2 border-b border-line-subtle px-5 py-2.5 max-md:px-3">
                  <ListSearch noun={NOUN[tab]} value={params.get("q") ?? ""} onChange={(v) => setParams({ q: v || null })} />
                  {tab === "schedules" && access.canManage && !creating ? (
                    <Button type="button" variant="primary" size="sm" icon="plus" className="ml-auto" onClick={() => setCreating(true)} data-testid="schedule-new">
                      New schedule
                    </Button>
                  ) : null}
                  {tab === "fires" && d.firesHasMore ? (
                    <span className="text-12-5 text-subtle">
                      The newest {d.fires.length} of {d.firesTotal}
                    </span>
                  ) : null}
                </div>
                {tab === "schedules" && creating ? (
                  <div className="border-b border-line-subtle px-5 py-4 max-md:px-3">
                    <ScheduleForm
                      submitLabel="Create schedule"
                      pending={create.isPending}
                      error={create.error}
                      testId="schedule-create"
                      onCancel={() => setCreating(false)}
                      onSubmit={(input) => create.mutate(input, { onSuccess: () => setCreating(false) })}
                    />
                  </div>
                ) : null}
                <GroupedList
                  ariaLabel={`Automation ${NOUN[tab]}`}
                  groups={groups}
                  fold={fold}
                  row={row}
                  selected={peek.open}
                  onPeek={(k) => peek.set(k === peek.open ? null : k)}
                  empty={text ? "Nothing matches this search." : `No ${NOUN[tab]} yet.`}
                  columns={COLUMNS[tab]}
                />
              </div>
              {open && tab === "schedules" ? (
                <SchedulePeek key={open.id} s={open as ScheduleStanding} access={access} peek={peek} onOpenFull={() => openFull(open.id)} />
              ) : null}
              {open && tab === "fires" ? (
                <FirePeek
                  key={open.id}
                  f={open as FireStanding}
                  schedule={scheduleOf((open as FireStanding).scheduleId)}
                  slug={slug}
                  peek={peek}
                  onOpenFull={() => openFull(open.id)}
                />
              ) : null}
              {open && tab === "reports" ? (
                <ReportPeek
                  key={open.id}
                  r={open as ReportStanding}
                  projectId={projectId}
                  slug={slug}
                  canWrite={access.canWrite}
                  peek={peek}
                  onOpenFull={() => openFull(open.id)}
                />
              ) : null}
            </div>
          </div>
        );
      }}
    </QueryBoundary>
  );
}
