"use client";

import type { OrphanedTrace } from "@forge/contracts/workflow-health";
import Link from "next/link";
import { useState } from "react";
import { Button, Textarea } from "@/design";
import { RefusalLine } from "@/lib/api/refusal-line";
import type { useDesignDecision } from "../hooks";
import type { DesignDecisionBody, WorkflowDesign } from "../types";

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

type NoteMode = "approve" | "return";

const NOTE_MODES: Record<NoteMode, { open: string; label: string; placeholder: string; submit: string; testid: string }> = {
  approve: {
    open: "Approve with a note",
    label: "Conditions of this approval",
    placeholder: "What the master still owes, or a deviation you accept",
    submit: "Approve",
    testid: "design-approve-note",
  },
  return: { open: "Return with reason", label: "Why it goes back", placeholder: "What the master should change", submit: "Return", testid: "design-return" },
};

// The acts that carry text sit in the banner that names the turn they answer, never beside the header's one-click Approve: an approval with its conditions, or a return with its reason, one box open at a time
export function DecisionNoteControl({ revision, decide }: { revision: number | null; decide: Decide }) {
  const [mode, setMode] = useState<NoteMode | null>(null);
  const [text, setText] = useState("");
  if (revision === null) return null;
  if (mode === null) {
    return (
      <span className="flex flex-wrap gap-x-3 gap-y-1">
        {(["approve", "return"] as const).map((m) => (
          <Button
            key={m}
            size="sm"
            variant="ghost"
            className="h-auto w-fit p-0 text-12-5 font-semibold text-link hover:bg-transparent hover:underline"
            onClick={() => setMode(m)}
            data-testid={`${NOTE_MODES[m].testid}-open`}
          >
            {NOTE_MODES[m].open}
          </Button>
        ))}
      </span>
    );
  }
  const m = NOTE_MODES[mode];
  const reason = text.trim();
  const body: DesignDecisionBody = mode === "approve" ? { revision, decision: "approve", reason } : { revision, decision: "return", reason };
  return (
    <span className="grid w-full max-w-[560px] basis-full gap-2" data-testid={m.testid}>
      <Textarea aria-label={m.label} placeholder={m.placeholder} value={text} onChange={(e) => setText(e.target.value)} rows={2} />
      <span className="flex gap-1.5">
        <Button size="sm" variant="secondary" onClick={() => setMode(null)}>
          Cancel
        </Button>
        <Button
          size="sm"
          variant={mode === "approve" ? "primary" : "secondary"}
          disabled={reason.length === 0 || decide.isPending}
          onClick={() => decide.mutate(body)}
          data-testid={`${m.testid}-submit`}
        >
          {m.submit} rev {revision}
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
