"use client";

// A kept template report, opened from the history: its narrative as it was kept (a slot nobody wrote
// is named, never drawn empty), then its blocks over the runs it holds. Export downloads it as
// Markdown from the same contract function core's export route uses; Share makes a members-only link
// of the kept document, shown once. Flat: hairline rows, no cards.

import type { ReportDocument } from "@forge/contracts/report-templates";
import { reportDocumentMarkdown, type StatusReportMeta, unwrittenSlots } from "@forge/contracts/status-reports";
import { useState } from "react";
import { Button } from "@/design";
import { ReportDocumentBody } from "@/features/shares";
import { formatApiError } from "@/lib/api/error";
import { formatDateTime } from "@/lib/i18n/format";
import { useCopy } from "@/lib/i18n/interface-language";
import type { EtaClock } from "@/features/forecast/eta";
import { useShareTemplateReport } from "../hooks";

/** The Markdown file of a kept template report: its narrative, then each block's text. */
export function templateReportFile(meta: StatusReportMeta, document: ReportDocument): { name: string; text: string } {
  const title = meta.template?.title ?? document.templateId;
  return {
    name: `${document.templateId}-${meta.asOf.slice(0, 10)}.md`,
    text: reportDocumentMarkdown(document, { title, asOf: meta.asOf }),
  };
}

function download({ name, text }: { name: string; text: string }): void {
  const url = URL.createObjectURL(new Blob([text], { type: "text/markdown;charset=utf-8" }));
  const a = window.document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

export function TemplateReport({ projectId, meta, document, clock }: { projectId: string; meta: StatusReportMeta; document: ReportDocument; clock: EtaClock }) {
  const t = useCopy();
  const share = useShareTemplateReport(projectId);
  const [link, setLink] = useState<string | null>(null);
  const unwritten = unwrittenSlots(document);
  return (
    <div className="grid gap-3" data-testid="template-report">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="text-14 font-semibold text-fg">{meta.template?.title ?? document.templateId}</h2>
        <span className="text-12-5 text-muted">{t("status.asOf", { at: formatDateTime(meta.asOf, clock.lang, clock.timeZone) })}</span>
        <span className="flex-1" />
        <Button size="sm" variant="ghost" onClick={() => download(templateReportFile(meta, document))} data-testid="template-report-export">
          {t("status.template.export")}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          loading={share.isPending}
          onClick={() =>
            share.mutate(meta.id, {
              onSuccess: (made) => setLink(new URL(made.url, window.location.origin).toString()),
            })
          }
          data-testid="template-report-share"
        >
          {t("status.template.share")}
        </Button>
      </div>
      {link ? (
        <p className="break-all text-13 text-fg" data-testid="template-report-link">
          {t("status.template.link")} <a className="text-link hover:underline" href={link}>{link}</a>
        </p>
      ) : null}
      {share.isError ? (
        <p className="text-13 text-danger" role="alert">
          {t("status.template.shareFailed")}: {formatApiError(share.error)}
        </p>
      ) : null}
      {unwritten.length > 0 ? <p className="text-13 text-muted">{t("status.template.unwritten", { slots: unwritten.join(", ") })}</p> : null}
      <ReportDocumentBody document={document} />
    </div>
  );
}
