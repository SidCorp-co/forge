"use client";

import Link from "next/link";
import { useState } from "react";
import { Badge, Button, ErrorState, Icon, PageTitle, ProjectLoader, Textarea, Toggle, Tooltip } from "@/design";
import { formatApiError } from "@/lib/api/error";
import { useQueryParam } from "@/lib/utils/use-query-param";
import { designDiff, stepsWithRemoved } from "../design-diff";
import { useDesignDecision, useWorkflowDesign, useWorkflows } from "../hooks";
import type { WorkflowDesign } from "../types";
import { WorkflowDiagram } from "./workflow-diagram";
import { DesignPill, StepDetail } from "./workflow-parts";

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
        <span className="flex gap-1.5">
          <Button size="sm" variant="secondary" onClick={() => setReturning(true)} disabled={decide.isPending}>
            Return…
          </Button>
          <Button
            size="sm"
            variant="primary"
            onClick={() => decide.mutate({ revision, decision: "approve" })}
            disabled={decide.isPending}
          >
            Approve design
          </Button>
        </span>
      )}
      {decide.isError ? <p className="text-12 text-red">{formatApiError(decide.error)}</p> : null}
    </div>
  );
}

export function WorkflowDesignScreen({ projectId, slug, flow }: { projectId: string; slug: string; flow: string }) {
  const list = useWorkflows(projectId);
  const record = list.data?.workflows.find((r) => r.document.flow === flow || r.document.id === flow) ?? null;
  const design = useWorkflowDesign(projectId, record?.document.id);
  const [stepParam, setStep] = useQueryParam("step");
  const [changes, setChanges] = useState(false);

  if (list.isLoading || (record && design.isLoading)) {
    return (
      <div className="grid min-h-[60vh] place-items-center">
        <ProjectLoader label="loading workflow…" />
      </div>
    );
  }
  if (list.isError || design.isError) {
    return (
      <div className="grid min-h-[60vh] place-items-center">
        <ErrorState message={formatApiError(list.error ?? design.error)} onRetry={() => (list.isError ? list.refetch() : design.refetch())} />
      </div>
    );
  }
  if (!record || !design.data) {
    return (
      <div className="grid min-h-[60vh] place-items-center">
        <ErrorState title="Workflow not found" message={`This project draws no workflow "${flow}".`} />
      </div>
    );
  }
  const d = design.data;
  const latest = d.revisions[0] ?? null;
  const pending = d.status === "proposed" || d.status === "returned";
  const shown = pending && latest ? latest.document : record.document;
  const approved = d.revisions.find((r) => r.revision === d.approvedRevision)?.document ?? null;
  const canDiff = approved !== null && pending && latest !== null && latest.revision !== d.approvedRevision;
  const diff = canDiff && changes && approved ? designDiff(approved, shown) : null;
  const steps = stepsWithRemoved(shown, diff);
  const step = steps.find((s) => s.id === stepParam) ?? steps[0];
  const shownRevision = pending && latest ? latest.revision : record.revision;
  const by = latest ? `${latest.proposedByName ?? latest.proposedBy} · ${new Date(latest.proposedAt).toLocaleString()}` : record.writerName;

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="workflow-design-screen">
      <header className="flex flex-wrap items-center gap-3 px-4 pb-3 pt-4 sm:px-7">
        <Link href={`/projects/${encodeURIComponent(slug)}/workflows`} className="text-muted hover:text-fg" aria-label="All workflows" title="All workflows">
          <Icon name="flow" size={16} />
        </Link>
        <PageTitle>{shown.title}</PageTitle>
        {d.status ? <DesignPill status={d.status} reason={d.status === "returned" ? latest?.reason : null} /> : null}
        <Tooltip label={by} side="bottom">
          <span className="font-mono text-12 text-subtle" data-testid="design-revision">
            r{shownRevision}
          </span>
        </Tooltip>
        {d.builds.length > 0 ? (
          <Tooltip label={d.builds.map((b) => `${b.displayId} ${b.title}`).join("\n")} side="bottom" multiline>
            <span>
              <Badge>
                {d.builds.length} {d.builds.length === 1 ? "build" : "builds"}
              </Badge>
            </span>
          </Tooltip>
        ) : null}
        {canDiff ? (
          <span className="ml-auto inline-flex items-center gap-2 text-12 font-semibold" title={`Against approved r${d.approvedRevision}`}>
            <Toggle checked={changes} onChange={setChanges} aria-label="Changes since approved" />
            Changes since approved
          </span>
        ) : null}
      </header>
      <div className="grid content-start gap-3 overflow-auto border-t border-line-subtle px-4 pb-6 pt-4 sm:px-7">
        <p className="text-13 text-muted" title={shown.summary}>
          {shown.summary}
        </p>
        <DecisionBar projectId={projectId} design={d} />
        <WorkflowDiagram workflow={{ ...shown, steps }} selected={step?.id ?? ""} onSelect={(id) => setStep(id)} diff={diff} />
        {step ? <StepDetail flow={shown.flow} kind={shown.kind} step={step} /> : null}
      </div>
    </div>
  );
}
