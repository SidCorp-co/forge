"use client";

// "Save report" on a chat answer that ran a template: keeps the template's runs in order, with the
// narrative the turn wrote, as a status report (`POST .../status/reports`), then links where it is
// kept. Core reads each run back as the saver and judges the narrative against the runs; a refusal
// reads as core's sentence in the answer's own row, and nothing is kept.

import Link from "next/link";
import type { TemplateSave } from "@/features/shares";
import { RefusalLine } from "@/lib/api/refusal-line";
import { useCopy } from "@/lib/i18n/interface-language";
import { keptReportHref } from "@/lib/routes/status";
import { useSaveTemplateReport } from "../hooks";

export function SaveTemplateReport({ projectId, projectSlug, save }: { projectId: string; projectSlug: string | undefined; save: TemplateSave }) {
  const t = useCopy();
  const keep = useSaveTemplateReport(projectId);
  if (keep.data) {
    return projectSlug ? (
      <Link href={keptReportHref(projectSlug, keep.data.id)} className="text-link hover:underline" data-testid="message-report-saved">
        {t("status.template.saved")}
      </Link>
    ) : (
      <span data-testid="message-report-saved">{t("status.template.saved")}</span>
    );
  }
  return (
    <>
      <button
        type="button"
        onClick={() => keep.mutate(save)}
        disabled={keep.isPending}
        className="rounded-sm underline-offset-2 hover:text-fg hover:underline disabled:opacity-60"
        data-testid="message-save-report"
      >
        {t("status.save")}
      </button>
      {keep.isError ? (
        <span className="basis-full">
          <RefusalLine error={keep.error} testid="message-save-refusal" />
        </span>
      ) : null}
    </>
  );
}
