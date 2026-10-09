"use client";

import type { IssuePatternView, PatternDecision } from "@forge/contracts/patterns";
import { useState } from "react";
import { Banner, Button, Field, Textarea } from "@/design";
import { formatApiError } from "@/lib/api/error";
import { useCopy } from "@/lib/i18n/interface-language";
import { useDecidePattern, useIssuePatterns } from "../patterns-api";

/**
 * The issue's new patterns and their one review (REQ-36 BC-2; Issue lifecycle r14 `design-check`).
 * Each new pattern shows its summary and where its review stands. A pending one the reader may
 * decide (core says which, `decidable`) is approved or returned here with a reason. A catalogued
 * pattern needs no review and is not shown.
 */
export function PatternsPanel({ issueId, projectId }: { issueId: string; projectId: string }) {
  const q = useIssuePatterns(issueId, projectId);
  const shown = (q.data?.patterns ?? []).filter((p) => p.kind === "new" && p.retractedAt === null);
  if (shown.length === 0) return null;
  const decidable = new Set(q.data?.decidable ?? []);
  return (
    <div className="grid gap-2" data-testid="issue-patterns">
      {shown.map((p) => (
        <PatternRow key={p.id} issueId={issueId} pattern={p} canDecide={decidable.has(p.id)} />
      ))}
    </div>
  );
}

function toneOf(p: IssuePatternView): "info" | "attention" | "danger" | "success" {
  if (p.pending) return "attention";
  if (p.unanswered) return "danger";
  return p.decision === "approved" ? "success" : "info";
}

function PatternRow({
  issueId,
  pattern,
  canDecide,
}: {
  issueId: string;
  pattern: IssuePatternView;
  canDecide: boolean;
}) {
  const t = useCopy();
  const [open, setOpen] = useState(false);
  const state = pattern.pending
    ? t("issues.patterns.pending")
    : pattern.decision === "approved"
      ? t("issues.patterns.approved", { reason: pattern.decisionReason ?? "" })
      : pattern.unanswered
        ? t("issues.patterns.returned", { reason: pattern.decisionReason ?? "" })
        : t("issues.patterns.answered", { reason: pattern.decisionReason ?? "" });
  return (
    <div className="grid gap-2" data-testid={`pattern-${pattern.pattern}`}>
      <Banner
        tone={toneOf(pattern)}
        action={
          canDecide && pattern.pending && !open ? (
            <Button size="sm" onClick={() => setOpen(true)}>
              {t("issues.patterns.review")}
            </Button>
          ) : undefined
        }
      >
        <span className="font-medium">{t("issues.patterns.title", { pattern: pattern.pattern })}</span>{" "}
        {state}
        {pattern.summary ? <span className="mt-1 block">{pattern.summary}</span> : null}
      </Banner>
      {open ? <DecideForm issueId={issueId} pattern={pattern} onClose={() => setOpen(false)} /> : null}
    </div>
  );
}

function DecideForm({
  issueId,
  pattern,
  onClose,
}: {
  issueId: string;
  pattern: IssuePatternView;
  onClose: () => void;
}) {
  const t = useCopy();
  const [reason, setReason] = useState("");
  const decide = useDecidePattern(issueId);
  const send = (decision: PatternDecision) =>
    decide.mutate({ patternId: pattern.id, decision, reason: reason.trim() }, { onSuccess: onClose });
  const blocked = decide.isPending || reason.trim() === "";
  return (
    <div className="grid gap-2 rounded-lg border border-line px-4 py-3" data-testid="pattern-decide">
      <Field
        label={t("issues.patterns.reason")}
        hint={t("issues.patterns.reasonHint")}
        error={decide.error ? `${t("issues.patterns.failed")}: ${formatApiError(decide.error)}` : undefined}
        required
      >
        <Textarea value={reason} rows={3} onChange={(e) => setReason(e.target.value)} />
      </Field>
      <div className="flex gap-2">
        <Button size="sm" variant="primary" disabled={blocked} onClick={() => send("approved")}>
          {t("issues.patterns.approve")}
        </Button>
        <Button size="sm" variant="secondary" disabled={blocked} onClick={() => send("returned")}>
          {t("issues.patterns.return")}
        </Button>
        <Button size="sm" variant="ghost" disabled={decide.isPending} onClick={onClose}>
          {t("issues.patterns.cancel")}
        </Button>
      </div>
    </div>
  );
}
