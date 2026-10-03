"use client";

import { useState } from "react";
import { Button, ErrorState, PageTitle, ProjectLoader, Textarea, Toggle, Tooltip } from "@/design";
import { DecisionsPanel } from "@/features/comments/components/decisions-panel";
import { useEntityDecisions } from "@/features/comments/hooks";
import { formatApiError } from "@/lib/api/error";
import { templateFor } from "../canvas/model";
import { WorkflowCanvas } from "../canvas/workflow-canvas";
import { SYSTEM_CONTEXT_TEMPLATE } from "../c4/model";
import { designDiff, stepsWithRemoved } from "../design-diff";
import { useDesignDecision, useWorkflowDesign, useWorkflowTemplates, useWorkflows } from "../hooks";
import type { WorkflowDesign } from "../types";
import { SystemContextView } from "./system-context-view";
import { DesignPill } from "./workflow-parts";

/** Approve, or Return with the reason the master revises against; only for the approver, only while it is proposed. */
function DecisionBar({ projectId, design }: { projectId: string; design: WorkflowDesign }) {
  const decide = useDesignDecision(projectId, design.workflowId);
  const [returning, setReturning] = useState(false);
  const [reason, setReason] = useState("");
  const revision = design.proposedRevision;
  if (design.status !== "proposed" || revision === null || !design.canDecide) return null;
  return (
    <div className="grid gap-2" data-testid="design-decision">
      {returning ? (
        <>
          <Textarea
            aria-label="Why it goes back"
            placeholder="What the master should change"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={2}
          />
          <span className="flex gap-1.5">
            <Button size="sm" variant="secondary" onClick={() => setReturning(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              variant="primary"
              disabled={reason.trim().length === 0 || decide.isPending}
              onClick={() => decide.mutate({ revision, decision: "return", reason: reason.trim() })}
            >
              Return with reason
            </Button>
          </span>
        </>
      ) : (
        <span className="flex flex-wrap gap-1.5">
          <Button size="sm" variant="secondary" onClick={() => setReturning(true)} disabled={decide.isPending}>
            Return with comments
          </Button>
          <Button size="sm" variant="primary" onClick={() => decide.mutate({ revision, decision: "approve" })} disabled={decide.isPending}>
            Approve design
          </Button>
        </span>
      )}
      {decide.isError ? <p className="text-12 text-red">{formatApiError(decide.error)}</p> : null}
    </div>
  );
}

function Chip({ label, tip, testId }: { label: string; tip: string; testId?: string }) {
  return (
    <Tooltip label={tip} side="bottom" multiline>
      <span className="rounded-pill border border-line-subtle bg-app px-2.5 py-0.5 text-12 font-medium text-muted" data-testid={testId}>
        {label}
      </span>
    </Tooltip>
  );
}

const centred = (node: React.ReactNode) => <div className="grid min-h-[60vh] place-items-center">{node}</div>;

export function WorkflowDesignScreen({ projectId, flow }: { projectId: string; slug: string; flow: string }) {
  const list = useWorkflows(projectId);
  const templates = useWorkflowTemplates(projectId);
  const record = list.data?.workflows.find((r) => r.document.flow === flow || r.document.id === flow) ?? null;
  const design = useWorkflowDesign(projectId, record?.document.id);
  const decisions = useEntityDecisions(projectId, "workflow", record?.document.id);
  const [changes, setChanges] = useState(false);
  const [showDecisions, setShowDecisions] = useState(false);

  if (list.isLoading || templates.isLoading || (record && design.isLoading)) return centred(<ProjectLoader label="loading workflow…" />);
  const failed = list.error ?? templates.error ?? design.error;
  if (failed) {
    return centred(
      <ErrorState message={formatApiError(failed)} onRetry={() => (list.isError ? list.refetch() : templates.isError ? templates.refetch() : design.refetch())} />,
    );
  }
  if (!record || !design.data) return centred(<ErrorState title="Workflow not found" message={`This project draws no workflow "${flow}".`} />);

  const d = design.data;
  const latest = d.revisions[0] ?? null;
  const pending = d.status === "proposed" || d.status === "returned";
  const shown = pending && latest ? latest.document : record.document;
  const template = templateFor(shown, (templates.data?.templates ?? []).map((t) => t.template));
  const approved = d.revisions.find((r) => r.revision === d.approvedRevision)?.document ?? null;
  const canDiff = approved !== null && pending && latest !== null && latest.revision !== d.approvedRevision;
  const diff = canDiff && changes && approved ? designDiff(approved, shown, template) : null;
  const steps = stepsWithRemoved(shown, diff);
  const shownRevision = pending && latest ? latest.revision : record.revision;
  const proposer = latest ? (latest.proposedByName ?? latest.proposedBy) : record.writerName;
  const updated = new Date(record.document.updatedAt).toLocaleString();
  const decision = <DecisionBar projectId={projectId} design={d} />;

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="workflow-design-screen">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2.5 border-b border-line-subtle bg-surface px-4 py-2.5">
        <div className="flex min-w-0 flex-[1_1_360px] flex-wrap items-center gap-x-2.5 gap-y-2">
          <PageTitle hint={shown.summary}>{shown.title}</PageTitle>
          {d.status ? <DesignPill status={d.status} reason={d.status === "returned" ? latest?.reason : null} /> : null}
          <Chip
            label={`rev ${shownRevision}`}
            tip={`Revision ${shownRevision} · updated ${updated} · ${shown.steps.length} steps, ${(shown.edges ?? []).length} contracts${template ? ` · drawn in ${template.title} (${template.id}@${template.version})` : ""}`}
            testId="design-revision"
          />
          <Chip label={`by ${proposer}`} tip={latest ? `Proposed by ${proposer} · ${new Date(latest.proposedAt).toLocaleString()}` : `Written by ${proposer}`} />
          {d.builds.length > 0 ? (
            <Chip label={`${d.builds.length} ${d.builds.length === 1 ? "build" : "builds"}`} tip={d.builds.map((b) => `${b.displayId} ${b.title}`).join("\n")} />
          ) : null}
        </div>
        {canDiff ? (
          <span className="inline-flex items-center gap-2 text-12 font-semibold" title={`Against approved r${d.approvedRevision}`}>
            <Toggle checked={changes} onChange={setChanges} aria-label="Changes since approved" />
            Changes since approved
          </span>
        ) : null}
        <Button size="sm" variant={showDecisions ? "primary" : "secondary"} onClick={() => setShowDecisions((v) => !v)} aria-pressed={showDecisions} data-testid="design-decisions-toggle">
          Decisions{decisions.data ? ` ${decisions.data.returned}` : ""}
        </Button>
        {decision}
      </header>
      <div className="flex min-h-0 flex-1">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {template?.id === SYSTEM_CONTEXT_TEMPLATE ? (
            <SystemContextView doc={{ ...shown, steps }} template={template} diff={diff} decision={decision} />
          ) : (
            <WorkflowCanvas doc={{ ...shown, steps }} template={template} diff={diff} decision={decision} />
          )}
        </div>
        {showDecisions ? (
          <aside className="w-[380px] shrink-0 overflow-y-auto border-l border-line-subtle bg-surface px-5 py-4 max-md:w-full" aria-label="Decisions" data-testid="design-decisions">
            <h2 className="mb-3 text-15 font-semibold text-fg">Decisions</h2>
            <DecisionsPanel projectId={projectId} scope="workflow" targetRef={record.document.id} />
          </aside>
        ) : null}
      </div>
    </div>
  );
}
