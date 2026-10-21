
// Development > Automation (ISS-116, prototype #/dev/automation, design automation rev 1 step
// screen): one area with tabs Schedules and Fires (`?tab=`), each the shared GroupedList with
// Needs you first, a peek (`?peek=`) and a full page per row, all read from GET /automation/standing
import {
  FIRE_GROUPS,
  FIRE_GROUP_LABELS,
  SCHEDULE_GROUPS,
  SCHEDULE_GROUP_LABELS,
} from "@forge/contracts/automation-standing";
import { useState } from "react";
import {
  Button,
  GroupedList,
  type ListGroup,
  ListLayout,
  ListSearch,
  ListToolbar,
  PageTitle,
  Tabs,
  useListPage,
  useUrlTab,
} from "@/design";
import { QueryBoundary } from "@/lib/api/query-boundary";
import { useCreateSchedule } from "../schedule-hooks";
import { useCopy, useInterfaceLanguage, useTimeFormat } from "@/lib/i18n/interface-language";
import type { Copy, ProductCopyKey } from "@/lib/i18n/product-copy";
import { useAutomationStanding } from "../hooks";
import { AUTOMATION_LIST, AUTOMATION_TABS, type AutomationTab, fireHref, scheduleHref } from "@/lib/routes/automation";
import type { AutomationStandingResponse, FireStanding, ScheduleStanding } from "../types";
import { automationGroups, type RowCtx } from "../view";
import { FirePeek, fireRow } from "./fire-views";
import { ScheduleForm } from "./schedule-form";
import { type AutomationAccess, SchedulePeek, scheduleRow } from "./schedule-views";

type Row = ScheduleStanding | FireStanding;

const searchOf: Record<AutomationTab, (r: Row) => string> = {
  schedules: (r) => { const s = r as ScheduleStanding; return [s.name, s.targetProjectSlug, s.owner?.name].join(" "); },
  fires: (r) => { const f = r as FireStanding; return [f.id, f.scheduleName].join(" "); },
};

function rowsOf(d: AutomationStandingResponse | undefined, tab: AutomationTab): Row[] {
  if (!d) return [];
  return tab === "schedules" ? d.schedules : d.fires;
}

function groupsOf(rows: Row[], tab: AutomationTab, t: Copy): ListGroup<Row>[] {
  if (tab === "schedules") return automationGroups(rows as ScheduleStanding[], SCHEDULE_GROUPS, SCHEDULE_GROUP_LABELS, "schedule", t);
  return automationGroups(rows as FireStanding[], FIRE_GROUPS, FIRE_GROUP_LABELS, "fire", t);
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
  const [tab, setTab] = useUrlTab(AUTOMATION_TABS);
  const noun = t(`schedules.noun.${tab}` as ProductCopyKey);
  const ctx: RowCtx = { t, language, time };
  const hrefOf = {
    schedules: (id: string) => scheduleHref(slug, id),
    fires: (id: string) => fireHref(slug, id),
  };
  const list = useListPage<Row>({
    rows: rowsOf(q.data, tab),
    keyOf: (r) => r.id,
    searchOf: searchOf[tab],
    groupsOf: (rows) => groupsOf(rows, tab, t),
    foldKey: `web-v2:automation-fold:${tab}`,
    hrefOf: (id) => hrefOf[tab](id),
    origin: AUTOMATION_LIST,
  });
  const { peek, fullOf } = list;

  const title = <PageTitle>{t("schedules.title")}</PageTitle>;
  return (
    <QueryBoundary query={q} loadingLabel={t("schedules.loadingAutomation")} title={title} height="60vh" retry="always">
      {(d) => {
        const tabs = [
          { value: "schedules", label: t("schedules.tab.schedules"), count: d.schedules.length },
          { value: "fires", label: t("schedules.tab.fires"), count: d.firesTotal },
        ];
        const row = (r: Row) =>
          tab === "schedules"
            ? scheduleRow(hrefOf.schedules, ctx)(r as ScheduleStanding)
            : fireRow(hrefOf.fires, ctx)(r as FireStanding);
        const open = peek.open ? list.rows.find((r) => r.id === peek.open) : undefined;
        const scheduleOf = (id: string) => d.schedules.find((s) => s.id === id);

        return (
          <div className="grid min-h-full content-start bg-app" data-testid="automation-screen">
            {title}
            <div className="border-b border-line-subtle px-5 max-md:px-2" data-testid="automation-tabs">
              <Tabs tabs={tabs} value={tab} onChange={(v) => setTab(v as AutomationTab)} />
            </div>
            <ListLayout
              peek={
                open ? (
                  <>
                    {tab === "schedules" ? (
                      <SchedulePeek key={open.id} s={open as ScheduleStanding} access={access} peek={peek} full={fullOf(open.id)} />
                    ) : null}
                    {tab === "fires" ? (
                      <FirePeek
                        key={open.id}
                        f={open as FireStanding}
                        schedule={scheduleOf((open as FireStanding).scheduleId)}
                        slug={slug}
                        peek={peek}
                        full={fullOf(open.id)}
                      />
                    ) : null}
                  </>
                ) : undefined
              }
            >
                <ListToolbar>
                  <ListSearch noun={noun} {...list.search} />
                  {tab === "schedules" && access.canManage && !creating ? (
                    <Button type="button" variant="primary" size="sm" icon="plus" className="ml-auto" onClick={() => setCreating(true)} data-testid="schedule-new">
                      {t("schedules.new")}
                    </Button>
                  ) : null}
                  {tab === "fires" && d.firesHasMore ? (
                    <span className="text-13 text-subtle">
                      {t("schedules.newest", { n: d.fires.length, total: d.firesTotal })}
                    </span>
                  ) : null}
                </ListToolbar>
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
                  groups={list.groups}
                  fold={list.fold}
                  row={row}
                  selected={peek.open}
                  onPeek={list.togglePeek}
                  empty={list.search.value ? t("schedules.emptySearch") : t("schedules.emptyList", { noun })}
                  columns={columnsOf(tab, t)}
                />
            </ListLayout>
          </div>
        );
      }}
    </QueryBoundary>
  );
}
