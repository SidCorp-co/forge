"use client";

import type { OrphanedTrace } from "@forge/contracts/workflow-health";
import Link from "next/link";
import { useState } from "react";
import { Button, Textarea } from "@/design";
import { RefusalLine } from "@/lib/api/refusal-line";
import { useCopy } from "@/lib/i18n/interface-language";
import type { Copy, ProductCopyKey } from "@/lib/i18n/product-copy";
import type { useDesignDecision } from "../hooks";
import type { DesignDecisionBody, WorkflowDesign } from "../types";

type Decide = ReturnType<typeof useDesignDecision>;

export function decidableRevision(d: WorkflowDesign): number | null {
  if (d.status !== "proposed" || d.proposedRevision === null || !d.canDecide) return null;
  return d.proposedRevision;
}

export function ApproveAction({ revision, decide }: { revision: number | null; decide: Decide }) {
  const t = useCopy();
  if (revision === null) return null;
  return (
    <Button size="sm" variant="primary" onClick={() => decide.mutate({ revision, decision: "approve" })} disabled={decide.isPending} data-testid="design-approve">
      {t("workflows.approveRev", { r: revision })}
    </Button>
  );
}

type NoteMode = "approve" | "return";

const NOTE_MODES: Record<NoteMode, { open: ProductCopyKey; label: ProductCopyKey; placeholder: ProductCopyKey; submit: ProductCopyKey; testid: string }> = {
  approve: {
    open: "workflows.note.approveOpen",
    label: "workflows.note.approveLabel",
    placeholder: "workflows.note.approvePlaceholder",
    submit: "workflows.note.approveSubmit",
    testid: "design-approve-note",
  },
  return: {
    open: "workflows.note.returnOpen",
    label: "workflows.note.returnLabel",
    placeholder: "workflows.note.returnPlaceholder",
    submit: "workflows.note.returnSubmit",
    testid: "design-return",
  },
};

// The acts that carry text sit in the banner that names the turn they answer, never beside the header's one-click Approve: an approval with its conditions, or a return with its reason, one box open at a time and each keeping its own draft
export function DecisionNoteControl({ revision, decide }: { revision: number | null; decide: Decide }) {
  const t = useCopy();
  const [mode, setMode] = useState<NoteMode | null>(null);
  const [drafts, setDrafts] = useState<Record<NoteMode, string>>({ approve: "", return: "" });
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
            {t(NOTE_MODES[m].open)}
          </Button>
        ))}
      </span>
    );
  }
  const m = NOTE_MODES[mode];
  const text = drafts[mode];
  const reason = text.trim();
  const body: DesignDecisionBody = mode === "approve" ? { revision, decision: "approve", reason } : { revision, decision: "return", reason };
  return (
    <span className="grid w-full max-w-[560px] basis-full gap-2" data-testid={m.testid}>
      <Textarea aria-label={t(m.label)} placeholder={t(m.placeholder)} value={text} onChange={(e) => setDrafts((d) => ({ ...d, [mode]: e.target.value }))} rows={2} />
      <span className="flex gap-1.5">
        <Button size="sm" variant="secondary" onClick={() => setMode(null)}>
          {t("workflows.cancel")}
        </Button>
        <Button
          size="sm"
          variant={mode === "approve" ? "primary" : "secondary"}
          disabled={reason.length === 0 || decide.isPending}
          onClick={() => decide.mutate(body)}
          data-testid={`${m.testid}-submit`}
        >
          {t(m.submit, { r: revision })}
        </Button>
      </span>
    </span>
  );
}

export function DecisionError({ decide }: { decide: Decide }) {
  return <RefusalLine error={decide.isError ? decide.error : null} testid="design-decision-error" />;
}

const RECORD_WORDS: Record<OrphanedTrace["recordType"], ProductCopyKey> = {
  requirement_criterion: "workflows.trace.criterion",
  feedback: "workflows.trace.feedback",
  suggestion: "workflows.trace.suggestion",
  build: "workflows.trace.build",
};

const traceTarget = (x: OrphanedTrace["target"], t: Copy) =>
  x.kind === "step" ? t("workflows.trace.step", { step: x.step }) : t("workflows.trace.line", { from: x.from, to: x.to, label: x.label ? ` “${x.label}”` : "" });
const traceKey = (x: OrphanedTrace["target"]) => (x.kind === "step" ? `step:${x.step}` : `line:${x.from}>${x.to}:${x.label ?? ""}`);

/**
 * The traces the proposed revision would leave pointing at nothing (workflow-step-health `d-orphans`),
 * each naming its record, for the approver to read before deciding; they never refuse the approval.
 */
export function OrphanedTraces({ traces, revision }: { traces: readonly OrphanedTrace[]; revision: number | null }) {
  const t = useCopy();
  if (traces.length === 0) return null;
  return (
    <details className="basis-full text-12-5" data-testid="orphaned-traces">
      <summary className="cursor-pointer select-none font-semibold text-fg">
        {t(traces.length === 1 ? "workflows.trace.headOne" : "workflows.trace.headMany", { n: traces.length })}
        {revision !== null ? t("workflows.trace.onceApproved", { r: revision }) : ""}
      </summary>
      <ul className="mt-1 grid max-w-[640px]">
        {traces.map((x) => (
          <li key={`${x.recordType}:${x.key}:${traceKey(x.target)}`} className="flex min-w-0 items-baseline gap-2 border-t border-line-subtle py-1 first:border-t-0" data-testid="orphaned-trace">
            <span className="flex-none text-subtle">{t(RECORD_WORDS[x.recordType])}</span>
            {x.href ? (
              <Link href={x.href} className="flex-none font-mono text-12 font-semibold text-link hover:underline">
                {x.key}
              </Link>
            ) : (
              <span className="flex-none font-mono text-12">{x.key}</span>
            )}
            <span className="min-w-0 truncate text-muted">{t("workflows.trace.removes", { target: traceTarget(x.target, t) })}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}
