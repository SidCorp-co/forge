"use client";

import { DetailHeader, ErrorState, ProjectLoader, useListOrigin } from "@/design";
import { useEntityDecisions } from "@/features/comments/hooks";
import { formatApiError, isRetryableApiError } from "@/lib/api/error";
import { templateFor } from "../canvas/model";
import { useDesignDecision, useWorkflowDesign, useWorkflowTemplates, useWorkflows } from "../hooks";
import { WORKFLOWS_LIST, workflowsHref } from "../routes";
import { ApproveAction, DecisionError, decidableRevision, ReturnControl } from "./design-decision";
import { shownDesign, useDesignTab, WorkflowDesignPage } from "./workflow-design-page";
import { DesignPill } from "./workflow-parts";

const centred = (node: React.ReactNode) => <div className="grid min-h-[40vh] place-items-center">{node}</div>;

// cm:why the shell's top bar is the page's sticky header (the shared DetailHeader): the named back control to Workflows, the flow, the title and the design's status; its one primary act is Approve while the design waits on the viewer
export function WorkflowDesignScreen({ projectId, slug, flow }: { projectId: string; slug: string; flow: string }) {
  const list = useWorkflows(projectId);
  const templates = useWorkflowTemplates(projectId);
  const record = list.data?.workflows.find((r) => r.document.flow === flow || r.document.id === flow) ?? null;
  const design = useWorkflowDesign(projectId, record?.document.id);
  const decisions = useEntityDecisions(projectId, "workflow", record?.document.id);
  const decide = useDesignDecision(projectId, record?.document.id ?? "");
  const [tab, setTab] = useDesignTab();
  const back = useListOrigin(WORKFLOWS_LIST, workflowsHref(slug));
  const d = design.data;
  const shown = d && record ? shownDesign(d, record).shown : (record?.document ?? null);
  const revision = d ? decidableRevision(d) : null;
  const failed = list.error ?? templates.error ?? design.error;

  let body: React.ReactNode;
  if (list.isLoading || templates.isLoading || (record && design.isLoading)) body = centred(<ProjectLoader label="loading workflow…" />);
  else if (failed) {
    const retry = () => (list.isError ? list.refetch() : templates.isError ? templates.refetch() : design.refetch());
    body = centred(<ErrorState message={formatApiError(failed)} onRetry={isRetryableApiError(failed) ? retry : undefined} />);
  } else if (!record || !d || !shown) body = centred(<ErrorState title="Workflow not found" message={`This project draws no workflow "${flow}".`} />);
  else {
    const template = templateFor(shown, (templates.data?.templates ?? []).map((t) => t.template));
    const returnControl = revision !== null ? (
      <>
        <ReturnControl revision={revision} decide={decide} />
        <DecisionError decide={decide} />
      </>
    ) : null;
    const walkDecision = revision !== null ? (
      <span className="grid gap-2">
        <ApproveAction revision={revision} decide={decide} />
        <ReturnControl revision={revision} decide={decide} />
      </span>
    ) : null;
    body = (
      <WorkflowDesignPage
        projectId={projectId}
        slug={slug}
        d={d}
        record={record}
        template={template}
        decisionCount={decisions.data?.returned}
        tab={tab}
        onTab={setTab}
        returnControl={returnControl}
        walkDecision={walkDecision}
      />
    );
  }

  return (
    <div className="min-h-full bg-app" data-testid="workflow-design-screen">
      <DetailHeader
        back={{ href: back, label: "Workflows" }}
        itemKey={record?.document.flow ?? flow}
        keyTitle={record?.document.id}
        title={shown?.title ?? flow}
        badge={d?.status ? <DesignPill status={d.status} reason={d.status === "returned" ? d.revisions[0]?.reason : null} /> : null}
        action={<ApproveAction revision={revision} decide={decide} />}
      />
      {body}
    </div>
  );
}
