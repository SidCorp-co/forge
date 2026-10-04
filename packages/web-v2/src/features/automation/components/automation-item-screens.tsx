"use client";

// cm:why each automation page's sticky header is the shared DetailHeader: "← Automation" back to the
// list view it was opened from (or to its schedule, for a fire; to its fire, for a report), the key,
// the title, the state badge and the one primary act
import { DetailHeader, StatusBadge, useListOrigin } from "@/design";
import { useFireDetail, useReportDetail, useScheduleDetail } from "../hooks";
import { AUTOMATION_LIST, automationListHref, automationTabHref, fireHref, scheduleHref } from "../routes";
import { shortId } from "../view";
import { FirePage } from "./fire-views";
import { ReportPage, ReportPrimary } from "./report-views";
import { type AutomationAccess, RunNow, SchedulePage } from "./schedule-views";

export function ScheduleItemScreen({ access, scheduleId }: { access: AutomationAccess; scheduleId: string }) {
  const s = useScheduleDetail(access.projectId, scheduleId, true).data?.schedule;
  const back = useListOrigin(AUTOMATION_LIST, automationListHref(access.slug));
  return (
    <div className="min-h-full bg-app" data-testid="schedule-item-screen">
      <DetailHeader
        back={{ href: back, label: "Automation" }}
        keyTitle={s?.id}
        title={s?.name ?? "Schedule"}
        badge={s ? <StatusBadge family="scheduleStanding" value={s.state} /> : null}
        action={s ? <RunNow s={s} access={access} /> : null}
      />
      <SchedulePage access={access} scheduleId={scheduleId} />
    </div>
  );
}

export function FireItemScreen({ access, fireId }: { access: AutomationAccess; fireId: string }) {
  const d = useFireDetail(access.projectId, fireId).data;
  const fallback = automationTabHref(access.slug, "fires");
  const origin = useListOrigin(AUTOMATION_LIST, automationListHref(access.slug));
  const back = d ? { href: scheduleHref(access.slug, d.schedule.id), label: d.schedule.name } : { href: origin || fallback, label: "Automation" };
  return (
    <div className="min-h-full bg-app" data-testid="fire-item-screen">
      <DetailHeader
        back={back}
        itemKey={`#${shortId(fireId)}`}
        keyTitle={fireId}
        title={d ? `Fire of ${d.fire.scheduleName}` : "Fire"}
        badge={d ? <StatusBadge family="scheduleRun" value={d.fire.status} /> : null}
      />
      <FirePage projectId={access.projectId} slug={access.slug} fireId={fireId} />
    </div>
  );
}

export function ReportItemScreen({ access, reportId }: { access: AutomationAccess; reportId: string }) {
  const r = useReportDetail(access.projectId, reportId).data?.report;
  const origin = useListOrigin(AUTOMATION_LIST, automationListHref(access.slug));
  const back = r?.fire
    ? { href: fireHref(access.slug, r.fire.id), label: `Fire #${shortId(r.fire.id)}` }
    : { href: origin, label: "Automation" };
  return (
    <div className="min-h-full bg-app" data-testid="report-item-screen">
      <DetailHeader
        back={back}
        itemKey={shortId(reportId)}
        keyTitle={reportId}
        title={r?.summary ?? "Agent report"}
        badge={r ? <StatusBadge family="reportTriage" value={r.triage} /> : null}
        action={r ? <ReportPrimary r={r} projectId={access.projectId} canWrite={access.canWrite} /> : null}
      />
      <ReportPage projectId={access.projectId} slug={access.slug} reportId={reportId} canWrite={access.canWrite} />
    </div>
  );
}
