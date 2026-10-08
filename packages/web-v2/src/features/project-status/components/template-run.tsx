"use client";

// The status page's Templates tab: run one of the build's report templates as the reader and read
// what it draws, then keep it. Run calls core's template door (`POST .../report-templates/:id/runs`),
// which runs each query as the reader and answers the document with an empty narrative; the document
// is drawn with the shared report body. Save report keeps those runs (`POST .../status/reports`), and
// the history lists the kept report. Flat: one heading, the form, the drawn report on hairlines.

import type { ReportDocument } from "@forge/contracts/report-templates";
import Link from "next/link";
import { useId, useState } from "react";
import { Button, ErrorState, ProjectLoader, ViewHeading } from "@/design";
import { ReportDocumentBody, useSaveTemplateReport } from "@/features/shares";
import { formatApiError } from "@/lib/api/error";
import { RefusalLine } from "@/lib/api/refusal-line";
import { useCopy } from "@/lib/i18n/interface-language";
import { keptReportHref } from "@/lib/routes/status";
import { useReportTemplates, useRunTemplate } from "../hooks";
import { TemplateParamFields, type TemplateParamValues, TemplatePicker, templateParamsOf } from "./template-params";

function DrawnReport({ projectId, slug, title, document }: { projectId: string; slug: string; title: string; document: ReportDocument }) {
  const t = useCopy();
  const save = useSaveTemplateReport(projectId);
  return (
    <section className="grid gap-2" data-testid="template-run-document">
      <ViewHeading
        right={
          save.data ? (
            <Link href={keptReportHref(slug, save.data.id)} className="text-13 text-link hover:underline" data-testid="template-run-saved">
              {t("status.template.saved")}
            </Link>
          ) : (
            <Button
              variant="primary"
              size="sm"
              disabled={save.isPending}
              onClick={() => save.mutate({ templateId: document.templateId, runIds: document.runs.map((r) => r.runId), narrative: {} })}
            >
              {t("status.save")}
            </Button>
          )
        }
      >
        {title}
      </ViewHeading>
      <RefusalLine error={save.error} testid="template-run-refusal" />
      <ReportDocumentBody document={document} />
    </section>
  );
}

export function TemplateRun({ projectId, slug }: { projectId: string; slug: string }) {
  const t = useCopy();
  const id = useId();
  const listing = useReportTemplates(projectId);
  const run = useRunTemplate(projectId);
  const [chosen, setChosen] = useState<string | null>(null);
  const [values, setValues] = useState<TemplateParamValues>({});
  if (listing.isError) return <ErrorState title={t("status.template.listFailed")} message={formatApiError(listing.error)} onRetry={() => listing.refetch()} />;
  if (!listing.data) return <ProjectLoader label={t("status.loading")} />;
  const templates = listing.data.templates;
  const template = templates.find((x) => x.id === chosen) ?? templates[0];
  if (!template) return <p className="text-13 text-muted">{t("status.template.none")}</p>;
  const pick = (next: string) => {
    setChosen(next);
    setValues({});
    run.reset();
  };
  return (
    <div className="grid gap-8" data-testid="template-run">
      <form
        className="grid max-w-2xl gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          run.mutate({ templateId: template.id, params: templateParamsOf(template.id, values) });
        }}
      >
        <ViewHeading hint={t("status.template.runHint")}>{t("status.template.runTitle")}</ViewHeading>
        <TemplatePicker id={`${id}-template`} label={t("status.template.pick")} templates={templates} value={template.id} onChange={pick} />
        <TemplateParamFields template={template} values={values} onChange={setValues} idPrefix={id} />
        <span>
          <Button type="submit" size="sm" disabled={run.isPending}>
            {t("status.template.run")}
          </Button>
        </span>
        <RefusalLine error={run.error} testid="template-run-run-refusal" />
      </form>
      {run.data ? <DrawnReport key={run.data.document.runs.map((r) => r.runId).join(",")} projectId={projectId} slug={slug} title={template.title} document={run.data.document} /> : null}
    </div>
  );
}
