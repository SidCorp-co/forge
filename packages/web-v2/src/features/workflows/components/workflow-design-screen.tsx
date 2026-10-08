"use client";

import { DetailHeader, ErrorState, ProjectLoader, useListOrigin } from "@/design";
import { useEntityDecisions } from "@/features/comments/hooks";
import { formatApiError, isRetryableApiError } from "@/lib/api/error";
import { useCopy } from "@/lib/i18n/interface-language";
import { templateFor } from "../canvas/model";
import { useDesignDecision, useWorkflowDesign, useWorkflowTemplates, useWorkflows } from "../hooks";
import { WORKFLOWS_LIST, workflowsHref } from "@/lib/routes/workflows";
import { ApprovalReading, ApproveAction, DecisionError, DecisionNoteControl, decidableRevision } from "./design-decision";
import { PinOnlyReading, RepinPanel } from "./design-repins";
import { shownDesign, useDesignTab, WorkflowDesignPage } from "./workflow-design-page";
import { DesignPill } from "./workflow-parts";

const centred = (node: React.ReactNode) => <div className="grid min-h-[40vh] place-items-center">{node}</div>;

// The shell's top bar is the page's sticky header (the shared DetailHeader): the named back control to Workflows, the flow, the title and the design's status; its one primary act is Approve while the design waits on the viewer
export function WorkflowDesignScreen({ projectId, slug, flow }: { projectId: string; slug: string; flow: string }) {
  const t = useCopy();
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
  if (list.isLoading || templates.isLoading || (record && design.isLoading)) body = centred(<ProjectLoader label={t("workflows.loadingOne")} />);
  else if (failed) {
    const retry = () => (list.isError ? list.refetch() : templates.isError ? templates.refetch() : design.refetch());
    body = centred(<ErrorState message={formatApiError(failed)} onRetry={isRetryableApiError(failed) ? retry : undefined} />);
  } else if (!record || !d || !shown) body = centred(<ErrorState title={t("workflows.notFound")} message={t("workflows.notFoundMessage", { flow })} />);
  else {
    const template = templateFor(shown, (templates.data?.templates ?? []).map((x) => x.template));
    const blocked = d.approvalBlocked !== null;
    const noteControl = revision !== null ? (
      <>
        <PinOnlyReading change={d.pinOnly} approvedRevision={d.approvedRevision} />
        <ApprovalReading revision={revision} block={d.approvalBlocked} leavesStale={d.approvalLeavesStale} />
        <DecisionNoteControl revision={revision} decide={decide} approveBlocked={blocked} />
        <DecisionError decide={decide} />
      </>
    ) : null;
    const walkDecision = revision !== null ? (
      <span className="grid gap-2">
        <ApproveAction revision={revision} decide={decide} block={d.approvalBlocked} />
        <ApprovalReading revision={revision} block={d.approvalBlocked} leavesStale={d.approvalLeavesStale} />
        <DecisionNoteControl revision={revision} decide={decide} approveBlocked={blocked} />
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
        noteControl={noteControl}
        walkDecision={walkDecision}
        repins={<RepinPanel projectId={projectId} workflowId={record.document.id} slug={slug} />}
      />
    );
  }

  return (
    <div className="min-h-full bg-app" data-testid="workflow-design-screen">
      <DetailHeader
        back={{ href: back, label: t("workflows.title") }}
        itemKey={record?.document.flow ?? flow}
        keyTitle={record?.document.id}
        title={shown?.title ?? flow}
        badge={d?.status ? <DesignPill status={d.status} reason={d.status === "returned" ? d.revisions[0]?.reason : null} /> : null}
        action={<ApproveAction revision={revision} decide={decide} block={d?.approvalBlocked} />}
      />
      {body}
    </div>
  );
}
