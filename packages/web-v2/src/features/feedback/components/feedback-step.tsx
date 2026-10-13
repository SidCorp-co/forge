
// The workflow step or link a feedback item hits (REQ-35 BC-8; Feedback lifecycle step `evidence`):
// that workflow on the canvas with the item's step lit and the rest dimmed, the highlight a process
// requirement's picture draws (ISS-460). A step the workflow's current design no longer has lights
// nothing and is named, never guessed at.

import type { NodeRef } from "@forge/contracts/workflow-health";
import { Link } from "@/lib/navigation/router";
import { type ReactNode, useMemo } from "react";
import { templateFor } from "@/features/workflows";
import { presentTrace } from "@/features/workflows";
import { WorkflowCanvas } from "@/features/workflows";
import { useWorkflowTemplates, useWorkflows } from "@/features/workflows";
import { useCopy } from "@/lib/i18n/interface-language";
import { workflowHref } from "@/lib/routes/workflows";

/** The one step or link an item names, as the canvas highlight reads it. */
function traceOf(node: NodeRef) {
  return "step" in node
    ? { steps: new Set([node.step]), edges: new Set<string>() }
    : { steps: new Set<string>(), edges: new Set([`${node.edge.from}>${node.edge.to}`]) };
}

export function FeedbackStep({ projectId, slug, flow, title, node }: { projectId: string; slug: string; flow: string; title: string | null; node: NodeRef }) {
  const t = useCopy();
  const list = useWorkflows(projectId);
  const templates = useWorkflowTemplates(projectId);
  const record = list.data?.workflows.find((r) => r.document.flow === flow) ?? null;
  const name = record?.document.title ?? title ?? flow;
  const traced = useMemo(() => traceOf(node), [node]);
  const shown = useMemo(() => (record ? presentTrace(traced, record.document.steps.map((s) => s.id)) : traced), [traced, record]);
  const lit = shown.steps.size + shown.edges.size > 0;
  const highlight = useMemo(() => (lit ? { steps: shown.steps, edges: shown.edges } : null), [shown, lit]);
  const label = (id: string) => {
    const s = record?.document.steps.find((x) => x.id === id);
    return s?.node?.label ?? s?.title ?? id;
  };
  const what = "step" in node ? label(node.step) : t("feedback.evidence.link", { from: label(node.edge.from), to: label(node.edge.to) });
  const alt = !record || lit ? t("feedback.evidence.stepAlt", { workflow: name, step: what }) : t("feedback.evidence.stepGone", { workflow: name, step: what });

  let canvas: ReactNode;
  if (record) {
    const template = templateFor(record.document, (templates.data?.templates ?? []).map((x) => x.template));
    canvas = <WorkflowCanvas doc={record.document} template={template} highlight={highlight} compact />;
  } else if (list.isError || list.isSuccess) {
    canvas = <p className="p-4 text-13 text-muted">{t("feedback.evidence.unread", { flow })}</p>;
  } else {
    canvas = <p className="p-4 text-13 text-muted">{t("feedback.evidence.loading")}</p>;
  }
  return (
    <figure aria-label={alt} className="m-0 grid min-w-0 gap-2" data-testid="feedback-step" data-lit={lit}>
      <figcaption className="flex flex-wrap items-center gap-x-3 gap-y-1 text-12 text-muted">
        <span className="font-semibold text-fg">{alt}</span>
        <Link href={workflowHref(slug, flow)} className="font-semibold text-link hover:underline">
          {t("feedback.evidence.open")}
        </Link>
      </figcaption>
      <div className="flex h-90 min-w-0 overflow-hidden rounded-md border border-line-subtle max-md:h-75" data-flow={flow}>
        {canvas}
      </div>
    </figure>
  );
}
