"use client";

// A kept template report, opened from the history: how its summary came to be (a schedule fire's
// outcome), its narrative as it was kept (a slot nobody wrote is named with why, never drawn empty),
// then its blocks over the runs it holds. Every export is core's (`GET .../export`): Export saves the
// Markdown it builds, and each table offers its CSV; the page builds no file of its own. Print hands
// the page to the print stylesheet, which drops these actions. Share opens the shared share dialog
// over the kept document. Flat: hairline rows, no cards.

import type { ReportDocument } from "@forge/contracts/report-templates";
import { narrativeOutcomeLine, type StatusReportDetail, unwrittenNarrativeLine } from "@forge/contracts/status-reports";
import { Button } from "@/design";
import type { EtaClock } from "@/features/forecast/eta";
import { ReportDocumentBody, ShareAction } from "@/features/shares";
import { formatApiError } from "@/lib/api/error";
import { formatDateTime } from "@/lib/i18n/format";
import { useCopy } from "@/lib/i18n/interface-language";
import { useExportStatusReport } from "../hooks";

export function TemplateReport({
  projectId,
  detail,
  document,
  clock,
}: {
  projectId: string;
  detail: Pick<StatusReportDetail, "report" | "narrative">;
  document: ReportDocument;
  clock: EtaClock;
}) {
  const t = useCopy();
  const meta = detail.report;
  const exporting = useExportStatusReport(projectId, meta.id, `${document.templateId}-${meta.asOf.slice(0, 10)}`);
  const outcome = narrativeOutcomeLine(detail.narrative);
  const unwritten = unwrittenNarrativeLine(document, detail.narrative);
  return (
    <div className="grid gap-3" data-testid="template-report">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="text-14 font-semibold text-fg">{meta.template?.title ?? document.templateId}</h2>
        <span className="text-12-5 text-muted">{t("status.asOf", { at: formatDateTime(meta.asOf, clock.lang, clock.timeZone) })}</span>
        <span className="flex-1" />
        <div className="flex items-center gap-1 print:hidden" data-testid="template-report-actions">
          <Button size="sm" variant="ghost" onClick={() => exporting.mutate(undefined)} disabled={exporting.isPending} data-testid="template-report-export">
            {t("status.template.export")}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => globalThis.print?.()} data-testid="template-report-print">
            {t("status.print")}
          </Button>
          <ShareAction projectId={projectId} subject={{ kind: "status-report", id: meta.id }} />
        </div>
      </div>
      {exporting.isError ? (
        <p role="alert" className="text-13 text-danger print:hidden">
          {t("status.template.exportFailed")}: {formatApiError(exporting.error)}
        </p>
      ) : null}
      {outcome ? (
        <p className="text-13 text-muted" data-testid="template-report-outcome" data-path={detail.narrative?.path}>
          {outcome}
        </p>
      ) : null}
      {unwritten ? (
        <p className="text-13 text-muted" data-testid="template-report-unwritten">
          {unwritten}
        </p>
      ) : null}
      <ReportDocumentBody document={document} onTableCsv={(index) => exporting.mutate(index)} />
    </div>
  );
}
