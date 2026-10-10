"use client";

import { type IssuePatternView, PATTERN_LIMITS, type PatternDecision } from "@forge/contracts/patterns";
import { useRef, useState } from "react";
import { Banner, Button, Field, Textarea } from "@/design";
import { formatApiError } from "@/lib/api/error";
import { useCopy } from "@/lib/i18n/interface-language";
import { useProjectMembers } from "../hooks";
import { useDecidePattern, useIssuePatterns } from "../patterns-api";

/** A pattern that still asks something of the issue: a review pending, or a return no later pattern answered. */
const stillOpen = (p: IssuePatternView) => p.pending || p.unanswered;

/**
 * The issue's new patterns and their one review (REQ-36 BC-2; Issue lifecycle r14 `design-check`).
 * Each new pattern shows its summary and where its review stands. A pending one the reader may
 * decide (core says which, `decidable`) is approved or returned here with a reason. A catalogued
 * pattern needs no review and is not shown. `show="open"` is the top of the page: the patterns that
 * still ask something, and a read that failed, since a held issue would otherwise show no reason for
 * the hold. `show="decided"` is Activity's: the decided ones, past items that do not sit at the top
 * (REQ-43 BC-8). A pattern decided while the page is open stays where it was read, so a form open
 * on it keeps the reason typed.
 */
export function PatternsPanel({ issueId, projectId, show }: { issueId: string; projectId: string; show: "open" | "decided" }) {
  const t = useCopy();
  const q = useIssuePatterns(issueId, projectId);
  const readOpen = useRef(new Set<string>());
  if (q.isError) {
    if (show === "decided") return null;
    return (
      <div data-testid="issue-patterns-failed">
        <Banner
          tone="danger"
          action={
            <Button size="sm" onClick={() => void q.refetch()}>
              {t("issues.patterns.retry")}
            </Button>
          }
        >
          {t("issues.patterns.readFailed")}
        </Banner>
      </div>
    );
  }
  const named = (q.data?.patterns ?? []).filter((p) => p.kind === "new" && p.retractedAt === null);
  if (show === "open") for (const p of named.filter(stillOpen)) readOpen.current.add(p.id);
  const shown = named.filter((p) => (show === "open" ? stillOpen(p) || readOpen.current.has(p.id) : !stillOpen(p)));
  if (shown.length === 0) return null;
  const decidable = new Set(q.data?.decidable ?? []);
  return (
    <div className="grid gap-2" data-testid={show === "open" ? "issue-patterns" : "issue-patterns-decided"}>
      {shown.map((p) => (
        <PatternRow
          key={p.id}
          issueId={issueId}
          projectId={projectId}
          pattern={p}
          canDecide={decidable.has(p.id)}
        />
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
  projectId,
  pattern,
  canDecide,
}: {
  issueId: string;
  projectId: string;
  pattern: IssuePatternView;
  canDecide: boolean;
}) {
  const t = useCopy();
  const [open, setOpen] = useState(false);
  const state = pattern.pending
    ? t("issues.patterns.pending")
    : pattern.decision === "approved"
      ? t("issues.patterns.approved", { reason: pattern.decisionReason ?? "" })
      : t("issues.patterns.returned", { reason: pattern.decisionReason ?? "" });
  // what follows a return stands on its own line, so the reason ends where its writer ended it
  const follow =
    pattern.decision !== "returned"
      ? null
      : pattern.unanswered
        ? t("issues.patterns.returnedHold")
        : t("issues.patterns.returnedAnswered");
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
        {follow ? (
          <span className="mt-1 block" data-testid="pattern-follow">
            {follow}
          </span>
        ) : null}
        {pattern.summary ? <span className="mt-1 block">{pattern.summary}</span> : null}
      </Banner>
      {/* the form outlives the pending state: a decision taken first elsewhere is said there, the reason kept */}
      {open ? (
        <DecideForm
          issueId={issueId}
          projectId={projectId}
          pattern={pattern}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </div>
  );
}

function DecideForm({
  issueId,
  projectId,
  pattern,
  onClose,
}: {
  issueId: string;
  projectId: string;
  pattern: IssuePatternView;
  onClose: () => void;
}) {
  const t = useCopy();
  const [reason, setReason] = useState("");
  const decide = useDecidePattern(issueId, projectId);
  const send = (decision: PatternDecision) =>
    decide.mutate({ patternId: pattern.id, decision, reason: reason.trim() }, { onSuccess: onClose });
  const length = reason.trim().length;
  const limit = PATTERN_LIMITS.reason;
  const tooLong = length > limit;
  const blocked = decide.isPending || length === 0 || tooLong;
  const decidedFirst = useDecidedFirst(pattern, projectId);
  const error =
    decidedFirst ??
    (tooLong
      ? t("issues.patterns.reasonTooLong", { count: String(length), limit: String(limit) })
      : decide.error
        ? `${t("issues.patterns.failed")}: ${formatApiError(decide.error)}`
        : undefined);
  return (
    <div className="grid gap-2 rounded-lg border border-line px-4 py-3" data-testid="pattern-decide">
      <Field
        label={t("issues.patterns.reason")}
        error={error}
        required
      >
        <Textarea value={reason} rows={3} onChange={(e) => setReason(e.target.value)} />
      </Field>
      <div className="flex gap-2">
        {decidedFirst ? null : (
          <>
            <Button size="sm" variant="primary" disabled={blocked} onClick={() => send("approved")}>
              {t("issues.patterns.approve")}
            </Button>
            <Button size="sm" variant="secondary" disabled={blocked} onClick={() => send("returned")}>
              {t("issues.patterns.return")}
            </Button>
          </>
        )}
        <Button size="sm" variant="ghost" disabled={decide.isPending} onClick={onClose}>
          {t("issues.patterns.cancel")}
        </Button>
      </div>
    </div>
  );
}

/**
 * Once the pattern stands decided while this form is open (a 409 PATTERN_ALREADY_DECIDED, or a
 * decision the event router brought in), the refusal said by name: who decided first, and that this
 * reviewer's reason was not recorded but is kept. Undefined while the pattern still waits.
 */
function useDecidedFirst(pattern: IssuePatternView, projectId: string): string | undefined {
  const t = useCopy();
  const members = useProjectMembers(pattern.pending ? undefined : projectId);
  if (pattern.pending || pattern.decision === null) return undefined;
  const member = members.data?.find((m) => m.userId === pattern.decidedBy);
  const who =
    pattern.decidedSession !== null
      ? t("issues.patterns.decidedByRun")
      : member
        ? (member.displayName ?? member.email)
        : t("issues.patterns.decidedBySomeone");
  return pattern.decision === "approved"
    ? t("issues.patterns.decidedFirstApproved", { who })
    : t("issues.patterns.decidedFirstReturned", { who });
}
