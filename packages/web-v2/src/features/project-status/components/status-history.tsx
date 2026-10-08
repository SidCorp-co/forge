"use client";

// History (the status page's second tab): every report the project kept, newest first, each dated
// and naming who or what produced it; opening one shows what changed since the report before it
// and the report as it was kept. Flat hairline rows; the open report's id rides the URL (`report`),
// which is where a sent report's notice and inbox row link to. The person who saved a report, or a
// project admin, removes it after a confirmation; a sent report is an admin's to remove (core's rule).

import type { StatusReportMeta } from "@forge/contracts/status-reports";
import { useEffect, useState } from "react";
import { Button, ConfirmDialog, ErrorState, ProjectLoader, useUrlParams, ViewHeading } from "@/design";
import type { EtaClock } from "@/features/forecast/eta";
import { formatApiError } from "@/lib/api/error";
import { formatDateTime } from "@/lib/i18n/format";
import { useCopy } from "@/lib/i18n/interface-language";
import { useAuth } from "@/providers/auth-provider";
import { projectStatusApi } from "../api";
import { useDeleteStatusReport, useStatusReport, useStatusReports } from "../hooks";
import { ReportSchedule } from "./report-schedule";
import { SinceLastReport } from "./since-last-report";
import { StatusReport } from "./status-report";
import { TemplateReport } from "./template-report";

/** Who or what produced a report, in the reader's language. */
export function producerText(r: StatusReportMeta, t: ReturnType<typeof useCopy>): string {
  if (r.producer.kind === "schedule") {
    return r.producer.schedule ? t("status.history.sentBy", { name: r.producer.schedule.name }) : t("status.history.sentByGone");
  }
  return t("status.history.savedBy", { name: r.producer.user?.name ?? t("status.history.someone") });
}

/** Whether the reader may remove a report, by the rule core enforces: its saver, or a project admin. */
export function mayRemoveReport(r: StatusReportMeta, viewer: { userId: string | null; isAdmin: boolean }): boolean {
  if (viewer.isAdmin) return true;
  return r.producer.kind === "person" && viewer.userId !== null && r.producer.user?.id === viewer.userId;
}

function RemoveReport({ projectId, report, when, onRemoved }: { projectId: string; report: StatusReportMeta; when: string; onRemoved: () => void }) {
  const t = useCopy();
  const [asking, setAsking] = useState(false);
  const remove = useDeleteStatusReport(projectId);
  return (
    <>
      <Button size="sm" variant="ghost" className="print:hidden" onClick={() => setAsking(true)} data-testid="status-history-remove">
        {t("status.history.delete")}
      </Button>
      <ConfirmDialog
        open={asking}
        tone="danger"
        title={t("status.history.deleteTitle")}
        message={
          <>
            <p>{t("status.history.deleteMessage", { at: when })}</p>
            {remove.isError ? (
              <p className="mt-2 text-danger" role="alert">
                {t("status.history.deleteFailed")}: {formatApiError(remove.error)}
              </p>
            ) : null}
          </>
        }
        confirmLabel={t("status.history.deleteConfirm")}
        loading={remove.isPending}
        onConfirm={() =>
          remove.mutate(report.id, {
            onSuccess: () => {
              setAsking(false);
              onRemoved();
            },
          })
        }
        onClose={() => {
          setAsking(false);
          remove.reset();
        }}
      />
    </>
  );
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
      {q.data.document ? (
        <div className="grid gap-3">
          <ViewHeading>{t("status.history.stored")}</ViewHeading>
          <TemplateReport projectId={projectId} detail={q.data} document={q.data.document} clock={clock} />
        </div>
      ) : q.data.status ? (
        <>
          <SinceLastReport detail={q.data} slug={slug} clock={clock} />
          <div className="grid gap-3">
            <ViewHeading>{t("status.history.stored")}</ViewHeading>
            <StatusReport s={q.data.status} slug={slug} clock={clock} />
          </div>
        </>
      ) : null}
    </div>
  );
}

export function StatusHistory({ projectId, slug, clock, isAdmin }: { projectId: string; slug: string; clock: EtaClock; isAdmin: boolean }) {
  const t = useCopy();
  const q = useStatusReports(projectId);
  const viewer = { userId: useAuth().user?.id ?? null, isAdmin };
  const [params, setParams] = useUrlParams();
  const open = params.get("report");
  const when = (iso: string) => formatDateTime(iso, clock.lang, clock.timeZone);
  return (
    <div className="grid gap-9" data-testid="status-history">
      {/* an open report prints alone: the list and the schedule are this screen's, not the report's */}
      <section aria-label={t("status.history.title")} className={open ? "grid gap-3 print:hidden" : "grid gap-3"}>
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
              <li key={r.id} className="flex items-center gap-2 border-b border-line-subtle">
                <button
                  type="button"
                  aria-current={r.id === open ? "true" : undefined}
                  onClick={() => setParams({ report: r.id === open ? null : r.id })}
                  className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-3 gap-y-0.5 py-2 text-left text-13 hover:bg-hover aria-[current=true]:font-semibold"
                  data-testid="status-history-row"
                >
                  <span className="text-fg">{when(r.asOf)}</span>
                  <span className="min-w-0 flex-1 text-muted">{producerText(r, t)}</span>
                  <span className="text-12-5 text-muted">{r.template ? r.template.title : t("status.window", { days: r.days ?? 0 })}</span>
                </button>
                {mayRemoveReport(r, viewer) ? (
                  <RemoveReport projectId={projectId} report={r} when={when(r.asOf)} onRemoved={() => (r.id === open ? setParams({ report: null }) : undefined)} />
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
      {open ? <OpenReport projectId={projectId} reportId={open} slug={slug} clock={clock} /> : null}
      <div className="print:hidden">
        <ReportSchedule projectId={projectId} />
      </div>
    </div>
  );
}
