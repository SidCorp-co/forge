
// A process requirement's picture where it links a workflow (REQ-35 BC-3; Requirement lifecycle r14
// step `picture`): that workflow on the canvas, the steps and links its live criteria trace lit and
// the rest dimmed, opened on the lit steps, with the way to the workflow's own page. A traced step the
// workflow's current design no longer has lights nothing and is named, so a trace left behind by a
// design change never reads as a lit picture with nothing lit.

import { Link } from "@/lib/navigation/router";
import { type ReactNode, useMemo, useState } from "react";
import { NativeSelect } from "@/design";
import { templateFor } from "@/features/workflows";
import { presentTrace } from "@/features/workflows";
import { WorkflowCanvas } from "@/features/workflows";
import { useWorkflowTemplates, useWorkflows } from "@/features/workflows";
import { useCopy } from "@/lib/i18n/interface-language";
import { workflowHref } from "@/lib/routes/workflows";
import type { TracedWorkflow } from "../picture-model";
import { Figure } from "./picture-figure";

/** A process requirement's linked workflow on the canvas, the steps and links its criteria trace lit and the rest dimmed. */
export function WorkflowPicture({ projectId, slug, traced }: { projectId: string; slug: string; traced: TracedWorkflow[] }) {
  const t = useCopy();
  const [chosen, setChosen] = useState<string | null>(null);
  const w = traced.find((x) => x.workflowId === chosen) ?? (traced[0]);
  const list = useWorkflows(projectId);
  const templates = useWorkflowTemplates(projectId);
  const record = list.data?.workflows.find((r) => r.document.id === w.workflowId) ?? null;
  const traces = w.steps.size + w.edges.size > 0;
  const shown = useMemo(() => (record ? presentTrace(w, record.document.steps.map((s) => s.id)) : { steps: w.steps, edges: w.edges, gone: [] }), [w, record]);
  const lit = shown.steps.size + shown.edges.size > 0;
  const highlight = useMemo(() => (lit ? { steps: shown.steps, edges: shown.edges } : null), [shown, lit]);
  const names = record ? record.document.steps.filter((s) => shown.steps.has(s.id)).map((s) => s.node?.label ?? s.title ?? s.id) : [];
  const gone = shown.gone.join(", ");
  let alt = t("requirements.picture.workflow.altNone", { title: w.title });
  let legend: string | null = t("requirements.picture.workflow.untraced");
  if (lit) {
    alt = t("requirements.picture.workflow.alt", { title: w.title, steps: names.join(", ") });
    legend = null;
  } else if (traces) {
    alt = t("requirements.picture.workflow.altGone", { title: w.title, steps: gone });
    legend = t("requirements.picture.workflow.allGone");
  }
  const head = (
    <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
      {legend ? <span>{legend}</span> : null}
      {lit && shown.gone.length > 0 ? <span>{t("requirements.picture.workflow.someGone", { steps: gone })}</span> : null}
      <Link href={workflowHref(slug, w.flow)} className="font-semibold text-link hover:underline">
        {t("requirements.picture.workflow.open")}
      </Link>
    </span>
  );
  let canvas: ReactNode;
  if (record) {
    const template = templateFor(record.document, (templates.data?.templates ?? []).map((x) => x.template));
    canvas = <WorkflowCanvas doc={record.document} template={template} highlight={highlight} compact />;
  } else if (list.isError || list.isSuccess) {
    canvas = <p className="p-4 text-13 text-muted">{t("requirements.picture.workflow.unread", { flow: w.flow })}</p>;
  } else {
    canvas = <p className="p-4 text-13 text-muted">{t("requirements.picture.workflow.loading")}</p>;
  }
  return (
    <Figure alt={alt} kind="workflow" by={head}>
      {traced.length > 1 ? (
        <div className="w-full max-w-80">
          <NativeSelect
            aria-label={t("requirements.picture.workflow.choose")}
            value={w.workflowId}
            onChange={(e) => setChosen(e.target.value)}
            options={traced.map((x) => ({ value: x.workflowId, label: x.title }))}
          />
        </div>
      ) : null}
      <div className="flex h-115 min-w-0 overflow-hidden border border-line-subtle max-md:h-105" data-testid="picture-workflow" data-flow={w.flow}>
        {canvas}
      </div>
    </Figure>
  );
}

