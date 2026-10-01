"use client";

import { Badge, EmptyState, ErrorState, PageTitle, ProjectLoader, Tooltip } from "@/design";
import { formatApiError } from "@/lib/api/error";
import { cn } from "@/lib/utils/cn";
import { useQueryParam } from "@/lib/utils/use-query-param";
import { useWorkflows } from "../hooks";
import { walkedOf } from "../layout";
import type { WorkflowKind, WorkflowRecord, WorkflowStep } from "../types";
import { WorkflowDiagram } from "./workflow-diagram";

function ListPill({ record }: { record: WorkflowRecord }) {
  const w = record.document;
  if (w.status === "writing") {
    return (
      <span className="rounded-pill border border-dashed border-line-strong px-2 text-11 font-semibold text-muted">writing</span>
    );
  }
  if (w.status === "rechecking") {
    return (
      <Tooltip label={w.drift?.reason ?? "re-checking"} side="bottom">
        <span>
          <Badge tone="amber">re-checking</Badge>
        </span>
      </Tooltip>
    );
  }
  if (w.kind === "state") return <Badge>state</Badge>;
  if (w.steps.every((s) => s.evidence?.coverage.reading !== "walked" && s.evidence?.coverage.reading !== "not_walked")) {
    return (
      <Tooltip label="No flow-coverage report reads these steps" side="bottom">
        <span>
          <Badge>unmeasured</Badge>
        </span>
      </Tooltip>
    );
  }
  const { walked, total } = walkedOf(w.steps);
  return (
    <Tooltip label="Steps the integration suite walks" side="bottom">
      <span>
        <Badge tone={walked === total ? "green" : "amber"}>
          {walked}/{total}
        </Badge>
      </span>
    </Tooltip>
  );
}

function coverageText(step: WorkflowStep): { label: string; tone: "green" | "amber" | "neutral" } | null {
  if (step.status === "writing") return { label: "being written", tone: "neutral" };
  const reading = step.evidence?.coverage.reading;
  if (reading === "walked") return { label: "walked by tests", tone: "green" };
  if (reading === "not_walked") return { label: "not walked · in baseline", tone: "amber" };
  if (reading === "unmeasured") return { label: "not measured by flow coverage", tone: "neutral" };
  return null;
}

function StepDetail({ flow, kind, step }: { flow: string; kind: WorkflowKind; step: WorkflowStep }) {
  const cov = coverageText(step);
  return (
    <div className="grid gap-1.5 rounded-lg border border-line-subtle bg-surface px-4 py-3.5 text-13" data-testid="workflow-step">
      <div className="flex flex-wrap items-center gap-2.5">
        <b className="font-mono">{kind === "flow" ? `${flow}/${step.id}` : step.id}</b>
        {cov ? <Badge tone={cov.tone}>{cov.label}</Badge> : null}
        {step.status === "rechecking" ? <Badge tone="amber">re-checking</Badge> : null}
      </div>
      <p>{step.does}</p>
      {step.evidence ? (
        <div className="flex flex-wrap items-center gap-2.5 text-12" data-testid="workflow-evidence">
          <span className="text-subtle">Evidence</span>
          <span className="font-mono">{step.evidence.file}</span>
          {step.evidence.symbol ? <span className="font-mono text-subtle">{step.evidence.symbol}</span> : null}
          {step.evidence.annotation ? (
            <span className="text-subtle">cm:flow {step.evidence.annotation}</span>
          ) : kind === "flow" ? (
            <span className="text-subtle">no cm:flow annotation yet</span>
          ) : null}
          {step.evidence.coverage.atSha ? (
            <span className="font-mono text-subtle">at {step.evidence.coverage.atSha.slice(0, 7)}</span>
          ) : null}
        </div>
      ) : kind === "flow" ? (
        <p className="text-12 text-subtle">
          No evidence yet: the master adds the step&rsquo;s cm:flow {flow}/{step.id} annotation as it writes it.
        </p>
      ) : null}
    </div>
  );
}

export function WorkflowsScreen({ projectId }: { projectId: string }) {
  const q = useWorkflows(projectId);
  const [tab, setTab] = useQueryParam("kind");
  const [picked, setPicked] = useQueryParam("flow");
  const [stepParam, setStep] = useQueryParam("step");
  const kind: WorkflowKind = tab === "state" ? "state" : "flow";

  if (q.isLoading) {
    return (
      <div className="grid min-h-[60vh] place-items-center">
        <ProjectLoader label="loading workflows…" />
      </div>
    );
  }
  if (q.isError || !q.data) {
    return (
      <div className="grid min-h-[60vh] place-items-center">
        <ErrorState message={formatApiError(q.error)} onRetry={() => q.refetch()} />
      </div>
    );
  }
  const shown = q.data.workflows.filter((r) => r.document.kind === kind);
  const current = shown.find((r) => r.document.flow === picked) ?? shown[0] ?? null;
  const w = current?.document ?? null;
  const step = w ? (w.steps.find((s) => s.id === stepParam) ?? w.steps[0]) : null;

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="workflows-screen">
      <header className="flex flex-wrap items-center gap-3 px-4 pb-3 pt-4 sm:px-7">
        <PageTitle className="fg-h2">Workflows</PageTitle>
        <span className="ml-auto inline-flex overflow-hidden rounded-lg border border-line" role="tablist">
          {(["flow", "state"] as const).map((k) => (
            <button
              key={k}
              type="button"
              role="tab"
              aria-selected={kind === k}
              onClick={() => {
                setTab(k === "flow" ? null : k);
                setPicked(null);
                setStep(null);
              }}
              className={cn("px-3 py-1 text-12 font-semibold", kind === k ? "bg-fg text-surface" : "text-muted")}
            >
              {k === "flow" ? "Flows" : "States"}
            </button>
          ))}
        </span>
      </header>
      {shown.length === 0 ? (
        <div className="border-t border-line-subtle p-8">
          <EmptyState
            title={kind === "flow" ? "No flow has been drawn" : "No state machine has been drawn"}
            message="The project's master draws each workflow from the code and keeps it current; nothing here is generated. None has been written for this project yet."
          />
        </div>
      ) : (
        <div className="grid min-h-0 flex-1 border-t border-line-subtle md:grid-cols-[260px_minmax(0,1fr)]">
          <div className="overflow-auto border-line-subtle md:border-r" data-testid="workflow-list">
            {shown.map((r) => (
              <button
                key={r.document.id}
                type="button"
                onClick={() => {
                  setPicked(r.document.flow);
                  setStep(null);
                }}
                title={r.document.summary}
                className={cn(
                  "grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-2.5 border-b border-line-subtle px-4 py-3 text-left text-13 hover:bg-hover sm:px-7",
                  current?.document.id === r.document.id && "bg-accent-tint",
                )}
                data-testid="workflow-row"
              >
                <span>
                  <b>{r.document.title}</b>
                  <br />
                  <span className="text-12 text-subtle">
                    {r.document.steps.length} {r.document.kind === "state" ? "states" : "steps"}
                  </span>
                </span>
                <ListPill record={r} />
              </button>
            ))}
          </div>
          {w && step && current ? (
            <div className="grid content-start gap-3 overflow-auto px-4 pb-6 pt-4 sm:px-7">
              <div className="flex flex-wrap items-center gap-2 text-11 font-semibold uppercase tracking-wide text-subtle">
                {w.title}
                <span className="ml-auto normal-case tracking-normal text-12 font-medium" title="The project's master owns this diagram: it writes it from the code, checks it against the cm:flow annotations and the tests, and re-checks a step when the code under it changes.">
                  {current.writerName} · refreshed at <span className="font-mono">{w.refreshedAtSha.slice(0, 7)}</span>
                </span>
              </div>
              {w.drift ? (
                <p className="flex items-center gap-2 text-12 text-amber" data-testid="workflow-drift">
                  <span className="size-2 rounded-full bg-amber" />
                  {w.drift.reason} · re-checking {w.drift.steps.join(", ")}
                </p>
              ) : null}
              <p className="text-13 text-muted">{w.summary}</p>
              <WorkflowDiagram workflow={w} selected={step.id} onSelect={(id) => setStep(id)} />
              <StepDetail flow={w.flow} kind={w.kind} step={step} />
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
