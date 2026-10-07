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
import { useCopy, useInterfaceLanguage, useTimeFormat } from "@/lib/i18n/interface-language";
import type { Copy, ProductCopyKey } from "@/lib/i18n/product-copy";
import { cn } from "@/lib/utils/cn";
import { useAutomationStanding } from "../hooks";
import { AUTOMATION_LIST, AUTOMATION_TABS, type AutomationTab, fireHref, reportHref, scheduleHref } from "@/lib/routes/automation";
import type { AutomationStandingResponse, FireStanding, ReportStanding, ScheduleStanding } from "../types";
import { automationGroups, type RowCtx } from "../view";
import { FirePeek, fireRow } from "./fire-views";
import { ReportPeek, reportRow } from "./report-views";
import { ScheduleForm } from "./schedule-form";
import { type AutomationAccess, SchedulePeek, scheduleRow } from "./schedule-views";

const matches = (text: string, ...parts: Array<string | null | undefined>) =>
  !text || parts.join(" ").toLowerCase().includes(text);

function tabRows(d: AutomationStandingResponse, tab: AutomationTab, text: string, t: Copy) {
  if (tab === "schedules") {
    const rows = d.schedules.filter((s) => matches(text, s.name, s.targetProjectSlug, s.owner?.name));
    return automationGroups(rows, SCHEDULE_GROUPS, SCHEDULE_GROUP_LABELS, "schedule", t) as ListGroup<ScheduleStanding | FireStanding | ReportStanding>[];
  }
  if (tab === "fires") {
    const rows = d.fires.filter((f) => matches(text, f.id, f.scheduleName));
    return automationGroups(rows, FIRE_GROUPS, FIRE_GROUP_LABELS, "fire", t) as ListGroup<ScheduleStanding | FireStanding | ReportStanding>[];
  }
  const rows = d.reports.filter((r) => matches(text, r.id, r.summary, r.fire?.scheduleName, r.targetRef));
  return automationGroups(rows, REPORT_GROUPS, REPORT_GROUP_LABELS, "report", t) as ListGroup<ScheduleStanding | FireStanding | ReportStanding>[];
}

const columnsOf = (tab: AutomationTab, t: Copy) => ({
  key: t(`schedules.col.${tab}.key` as ProductCopyKey),
  title: t(`schedules.col.${tab}.title` as ProductCopyKey),
  state: t(`schedules.col.${tab}.state` as ProductCopyKey),
  waitingOn: t(`schedules.col.${tab}.waitingOn` as ProductCopyKey),
  meta: t(`schedules.col.${tab}.meta` as ProductCopyKey),
});

export function AutomationScreen({ access }: { access: AutomationAccess }) {
  const { projectId, slug } = access;
  const t = useCopy();
  const language = useInterfaceLanguage();
  const time = useTimeFormat();
  const q = useAutomationStanding(projectId);
  const create = useCreateSchedule(projectId);
  const [creating, setCreating] = useState(false);
  const router = useRouter();
  const [tab, setTab] = useUrlTab(AUTOMATION_TABS);
  const [params, setParams] = useUrlParams();
  const text = (params.get("q") ?? "").trim().toLowerCase();
  const fold = useGroupFold(`web-v2:automation-fold:${tab}`);
  const d = q.data;
  const groups = useMemo(() => (d ? tabRows(d, tab, text, t) : []), [d, tab, text, t]);
  const noun = t(`schedules.noun.${tab}` as ProductCopyKey);
  const ctx: RowCtx = useMemo(() => ({ t, language, time }), [t, language, time]);
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

  const title = <PageTitle hint={t("schedules.titleHint")}>{t("schedules.title")}</PageTitle>;
  return (
    <QueryBoundary query={q} loadingLabel={t("schedules.loadingAutomation")} title={title} height="60vh" retry="always">
      {(d) => {
        const tabs = [
          { value: "schedules", label: t("schedules.tab.schedules"), count: d.schedules.length },
          { value: "fires", label: t("schedules.tab.fires"), count: d.firesTotal },
          { value: "reports", label: t("schedules.tab.reports"), count: d.reportCounts.new },
        ];
        const row = (r: ScheduleStanding | FireStanding | ReportStanding) =>
          tab === "schedules"
            ? scheduleRow(hrefOf.schedules, ctx)(r as ScheduleStanding)
            : tab === "fires"
              ? fireRow(hrefOf.fires, ctx)(r as FireStanding)
              : reportRow(hrefOf.reports, ctx)(r as ReportStanding);
        const open = peek.open ? groups.flatMap((g) => g.rows).find((r) => r.id === peek.open) : undefined;
        const scheduleOf = (id: string) => d.schedules.find((s) => s.id === id);

        return (
          <div className="grid min-h-full content-start bg-app" data-testid="automation-screen">
            {title}
            <div className="border-b border-line-subtle px-5 max-md:px-2" data-testid="automation-tabs">
              <Tabs tabs={tabs} value={tab} onChange={(v) => setTab(v as AutomationTab)} />
            </div>
            <div className={cn("grid min-h-[60vh] items-start", open && "lg:grid-cols-[minmax(0,1fr)_minmax(380px,440px)]")}>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2 border-b border-line-subtle px-5 py-2.5 max-md:px-3">
                  <ListSearch noun={noun} value={params.get("q") ?? ""} onChange={(v) => setParams({ q: v || null })} />
                  {tab === "schedules" && access.canManage && !creating ? (
                    <Button type="button" variant="primary" size="sm" icon="plus" className="ml-auto" onClick={() => setCreating(true)} data-testid="schedule-new">
                      {t("schedules.new")}
                    </Button>
                  ) : null}
                  {tab === "fires" && d.firesHasMore ? (
                    <span className="text-12-5 text-subtle">
                      {t("schedules.newest", { n: d.fires.length, total: d.firesTotal })}
                    </span>
                  ) : null}
                </div>
                {tab === "schedules" && creating ? (
                  <div className="border-b border-line-subtle px-5 py-4 max-md:px-3">
                    <ScheduleForm
                      submitLabel={t("schedules.create")}
                      pending={create.isPending}
                      error={create.error}
                      testId="schedule-create"
                      onCancel={() => setCreating(false)}
                      onSubmit={(input) => create.mutate(input, { onSuccess: () => setCreating(false) })}
                    />
                  </div>
                ) : null}
                <GroupedList
                  ariaLabel={t("schedules.ariaList", { noun })}
                  groups={groups}
                  fold={fold}
                  row={row}
                  selected={peek.open}
                  onPeek={(k) => peek.set(k === peek.open ? null : k)}
                  empty={text ? t("schedules.emptySearch") : t("schedules.emptyList", { noun })}
                  columns={columnsOf(tab, t)}
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
