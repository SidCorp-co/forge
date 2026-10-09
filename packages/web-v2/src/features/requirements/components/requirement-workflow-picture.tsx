"use client";

// A process requirement's picture where it links a workflow (REQ-35 BC-3; Requirement lifecycle r14
// step `picture`): that workflow on the canvas, the steps and links its live criteria trace lit and
// the rest dimmed, opened on the lit steps, with the way to the workflow's own page.

import Link from "next/link";
import { type ReactNode, useMemo, useState } from "react";
import { NativeSelect } from "@/design";
import { templateFor } from "@/features/workflows/canvas/model";
import { WorkflowCanvas } from "@/features/workflows/canvas/workflow-canvas";
import { useWorkflowTemplates, useWorkflows } from "@/features/workflows/hooks";
import { useCopy } from "@/lib/i18n/interface-language";
import { workflowHref } from "@/lib/routes/workflows";
import type { TracedWorkflow } from "../picture-model";
import { Figure } from "./picture-figure";

/** A process requirement's linked workflow on the canvas, the steps and links its criteria trace lit and the rest dimmed. */
export function WorkflowPicture({ projectId, slug, traced }: { projectId: string; slug: string; traced: TracedWorkflow[] }) {
  const t = useCopy();
  const [chosen, setChosen] = useState<string | null>(null);
  const w = traced.find((x) => x.workflowId === chosen) ?? (traced[0] as TracedWorkflow);
  const list = useWorkflows(projectId);
  const templates = useWorkflowTemplates(projectId);
  const record = list.data?.workflows.find((r) => r.document.id === w.workflowId) ?? null;
  const lit = w.steps.size + w.edges.size > 0;
  const highlight = useMemo(() => (lit ? { steps: w.steps, edges: w.edges } : null), [w, lit]);
  const names = record ? record.document.steps.filter((s) => w.steps.has(s.id)).map((s) => s.node?.label ?? s.title ?? s.id) : [];
  const alt = lit ? t("requirements.picture.workflow.alt", { title: w.title, steps: names.join(", ") }) : t("requirements.picture.workflow.altNone", { title: w.title });
  const head = (
    <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
      <span>{lit ? t("requirements.picture.workflow.legend") : t("requirements.picture.workflow.untraced")}</span>
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
        <div className="w-full max-w-[320px]">
          <NativeSelect
            aria-label={t("requirements.picture.workflow.choose")}
            value={w.workflowId}
            onChange={(e) => setChosen(e.target.value)}
            options={traced.map((x) => ({ value: x.workflowId, label: x.title }))}
          />
        </div>
      ) : null}
      <div className="flex h-[460px] min-w-0 overflow-hidden border border-line-subtle max-md:h-[420px]" data-testid="picture-workflow" data-flow={w.flow}>
        {canvas}
      </div>
    </Figure>
  );
}

