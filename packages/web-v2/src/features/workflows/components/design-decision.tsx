"use client";

import type { OrphanedTrace } from "@forge/contracts/workflow-health";
import Link from "next/link";
import { useState } from "react";
import { Button, Textarea } from "@/design";
import { RefusalLine } from "@/lib/api/refusal-line";
import type { useDesignDecision } from "../hooks";
import type { WorkflowDesign } from "../types";

type Decide = ReturnType<typeof useDesignDecision>;

export function decidableRevision(d: WorkflowDesign): number | null {
  if (d.status !== "proposed" || d.proposedRevision === null || !d.canDecide) return null;
  return d.proposedRevision;
}

export function ApproveAction({ revision, decide }: { revision: number | null; decide: Decide }) {
  if (revision === null) return null;
  return (
    <Button size="sm" variant="primary" onClick={() => decide.mutate({ revision, decision: "approve" })} disabled={decide.isPending} data-testid="design-approve">
      Approve rev {revision}
    </Button>
  );
}

// Return is the secondary act, so it sits in the banner that names the turn it answers, never beside the header's Approve
export function ReturnControl({ revision, decide }: { revision: number | null; decide: Decide }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  if (revision === null) return null;
  if (!open) {
    return (
      <Button
        size="sm"
        variant="ghost"
        className="h-auto w-fit p-0 text-12-5 font-semibold text-link hover:bg-transparent hover:underline"
        onClick={() => setOpen(true)}
        data-testid="design-return-open"
      >
        Return with reason
      </Button>
    );
  }
  return (
    <span className="grid w-full max-w-[560px] basis-full gap-2" data-testid="design-return">
      <Textarea aria-label="Why it goes back" placeholder="What the master should change" value={reason} onChange={(e) => setReason(e.target.value)} rows={2} />
      <span className="flex gap-1.5">
        <Button size="sm" variant="secondary" onClick={() => setOpen(false)}>
          Cancel
        </Button>
        <Button
          size="sm"
          variant="secondary"
          disabled={reason.trim().length === 0 || decide.isPending}
          onClick={() => decide.mutate({ revision, decision: "return", reason: reason.trim() })}
          data-testid="design-return-submit"
        >
          Return rev {revision}
        </Button>
      </span>
    </span>
  );
}

export function DecisionError({ decide }: { decide: Decide }) {
  return <RefusalLine error={decide.isError ? decide.error : null} testid="design-decision-error" />;
}

const RECORD_WORDS: Record<OrphanedTrace["recordType"], string> = {
  requirement_criterion: "Criterion",
  feedback: "Feedback",
  suggestion: "Suggestion",
  build: "Build",
};

const traceTarget = (t: OrphanedTrace["target"]) => (t.kind === "step" ? `step ${t.step}` : `line ${t.from} → ${t.to}${t.label ? ` “${t.label}”` : ""}`);

/**
 * The traces the proposed revision would leave pointing at nothing (workflow-step-health `d-orphans`),
 * each naming its record, for the approver to read before deciding; they never refuse the approval.
 */
export function OrphanedTraces({ traces, revision }: { traces: readonly OrphanedTrace[]; revision: number | null }) {
  if (traces.length === 0) return null;
  return (
    <details className="basis-full text-12-5" data-testid="orphaned-traces">
      <summary className="cursor-pointer select-none font-semibold text-fg">
        {traces.length} {traces.length === 1 ? "trace" : "traces"} would point at nothing{revision !== null ? ` once rev ${revision} is approved` : ""}
      </summary>
      <ul className="mt-1 grid max-w-[640px]">
        {traces.map((t) => (
          <li key={`${t.recordType}:${t.key}:${traceTarget(t.target)}`} className="flex min-w-0 items-baseline gap-2 border-t border-line-subtle py-1 first:border-t-0" data-testid="orphaned-trace">
            <span className="flex-none text-subtle">{RECORD_WORDS[t.recordType]}</span>
            {t.href ? (
              <Link href={t.href} className="flex-none font-mono text-12 font-semibold text-link hover:underline">
                {t.key}
              </Link>
            ) : (
              <span className="flex-none font-mono text-12">{t.key}</span>
            )}
            <span className="min-w-0 truncate text-muted">traces {traceTarget(t.target)}, which the revision removes</span>
          </li>
        ))}
      </ul>
    </details>
  );
}
