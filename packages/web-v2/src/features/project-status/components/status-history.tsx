"use client";

// History (the status page's second tab): every report the project kept, newest first, each dated
// and naming who or what produced it; opening one shows what changed since the report before it
// and the report as it was kept. Flat hairline rows; the open report's id rides the URL (`report`),
// which is where a sent report's notice and inbox row link to.

import type { StatusReportMeta } from "@forge/contracts/status-reports";
import { useEffect } from "react";
import { ErrorState, ProjectLoader, useUrlParams, ViewHeading } from "@/design";
import type { EtaClock } from "@/features/forecast/eta";
import { formatApiError } from "@/lib/api/error";
import { formatDateTime } from "@/lib/i18n/format";
import { useCopy } from "@/lib/i18n/interface-language";
import { projectStatusApi } from "../api";
import { useStatusReport, useStatusReports } from "../hooks";
import { ReportSchedule } from "./report-schedule";
import { SinceLastReport } from "./since-last-report";
import { StatusReport } from "./status-report";

/** Who or what produced a report, in the reader's language. */
export function producerText(r: StatusReportMeta, t: ReturnType<typeof useCopy>): string {
  if (r.producer.kind === "schedule") {
    return r.producer.schedule ? t("status.history.sentBy", { name: r.producer.schedule.name }) : t("status.history.sentByGone");
  }
  return t("status.history.savedBy", { name: r.producer.user?.name ?? t("status.history.someone") });
}

function OpenReport({ projectId, reportId, slug, clock }: { projectId: string; reportId: string; slug: string; clock: EtaClock }) {
  const t = useCopy();
  const q = useStatusReport(projectId, reportId);
  useEffect(() => {
    // opening a report is reading its notice: the inbox row and the bell's unread mark clear
    projectStatusApi.markRead(projectId, reportId).catch(() => undefined);
  }, [projectId, reportId]);
  if (q.isError) return <ErrorState title={t("status.history.loadFailed")} message={formatApiError(q.error)} onRetry={() => q.refetch()} />;
  if (!q.data) return <ProjectLoader label={t("status.loading")} />;
  return (
    <div className="grid gap-9" data-testid="status-history-open">
      <SinceLastReport detail={q.data} slug={slug} clock={clock} />
      <div className="grid gap-3">
        <ViewHeading>{t("status.history.stored")}</ViewHeading>
        <StatusReport s={q.data.status} slug={slug} clock={clock} />
      </div>
    </div>
  );
}

export function StatusHistory({ projectId, slug, clock }: { projectId: string; slug: string; clock: EtaClock }) {
  const t = useCopy();
  const q = useStatusReports(projectId);
  const [params, setParams] = useUrlParams();
  const open = params.get("report");
  const when = (iso: string) => formatDateTime(iso, clock.lang, clock.timeZone);
  return (
    <div className="grid gap-9" data-testid="status-history">
      <section aria-label={t("status.history.title")} className="grid gap-3">
        <ViewHeading>{t("status.history.title")}</ViewHeading>
        {q.isError ? (
          <ErrorState title={t("status.history.loadFailed")} message={formatApiError(q.error)} onRetry={() => q.refetch()} />
        ) : !q.data ? (
          <ProjectLoader label={t("status.loading")} />
        ) : q.data.reports.length === 0 ? (
          <p className="text-13 text-muted">{t("status.history.none")}</p>
        ) : (
          <ul className="border-t border-line-subtle">
            {q.data.reports.map((r) => (
              <li key={r.id}>
                <button
                  type="button"
                  aria-current={r.id === open ? "true" : undefined}
                  onClick={() => setParams({ report: r.id === open ? null : r.id })}
                  className="flex w-full flex-wrap items-baseline gap-x-3 gap-y-0.5 border-b border-line-subtle py-2 text-left text-13 hover:bg-hover aria-[current=true]:font-semibold"
                  data-testid="status-history-row"
                >
                  <span className="text-fg">{when(r.asOf)}</span>
                  <span className="min-w-0 flex-1 text-muted">{producerText(r, t)}</span>
                  <span className="text-12-5 text-muted">{t("status.window", { days: r.days })}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
      {open ? <OpenReport projectId={projectId} reportId={open} slug={slug} clock={clock} /> : null}
      <ReportSchedule projectId={projectId} />
    </div>
  );
}
