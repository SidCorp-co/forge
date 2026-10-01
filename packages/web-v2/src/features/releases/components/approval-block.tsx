"use client";

import { useState } from "react";
import { Button, Textarea } from "@/design";
import { formatApiError } from "@/lib/api/error";
import { shortSha, stampOf } from "../format";
import { useReleaseDecision } from "../versions-hooks";
import type { ReleaseApproval } from "../versions-types";

export interface ApprovalBlockProps {
  projectId: string;
  approval: ReleaseApproval;
  canDecide: boolean;
  issueCount: number;
}

export function ApprovalBlock({ projectId, approval, canDecide, issueCount }: ApprovalBlockProps) {
  const decide = useReleaseDecision(projectId);
  const [returning, setReturning] = useState(false);
  const [reason, setReason] = useState("");
  const send = (body: { decision: "approve" } | { decision: "return"; reason: string }) =>
    decide.mutate({ runId: approval.runId, approvalId: approval.id, body });

  if (approval.decision === "returned") {
    return (
      <div className="grid gap-1 rounded-lg border border-line bg-sunken px-3.5 py-3 text-13" data-testid="approval-returned">
        <b>Returned by {approval.decidedBy?.name}</b>
        <span className="text-muted">{approval.reason}</span>
        <span className="text-12 text-subtle">
          {approval.decidedAt ? stampOf(approval.decidedAt) : ""} · the issues stay in this release until it is asked again
        </span>
      </div>
    );
  }

  return (
    <div
      className="grid gap-3 rounded-lg px-3.5 py-3 text-13"
      style={{ background: "var(--amber-50, #f6edd2)", border: "1px solid color-mix(in srgb, var(--amber-500, #8a6200) 35%, transparent)" }}
      data-testid="approval-block"
    >
      <div className="flex flex-wrap items-center gap-3">
        <div className="grid gap-0.5">
          <b>Production waits for an admin</b>
          <span className="text-12 text-muted">
            requested by {approval.requestedBy.name} · {stampOf(approval.requestedAt)} · {issueCount} issues
          </span>
        </div>
        {canDecide && !returning ? (
          <span className="ml-auto flex gap-1.5">
            <Button size="sm" variant="secondary" onClick={() => setReturning(true)} disabled={decide.isPending}>
              Return…
            </Button>
            <Button size="sm" variant="primary" onClick={() => send({ decision: "approve" })} disabled={decide.isPending}>
              Approve release
            </Button>
          </span>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-2 text-12" data-testid="approval-evidence">
        <span className="text-subtle">Evidence</span>
        <span className="font-semibold">{approval.evidence.environment}</span>
        <span className="font-mono">{shortSha(approval.evidence.commit)}</span>
        <span className="text-muted">{approval.evidence.reading}</span>
      </div>
      {approval.note ? <p className="text-12 text-muted">{approval.note}</p> : null}
      {!canDecide ? (
        <p className="text-12 text-subtle">An admin of this project approves or returns it.</p>
      ) : null}
      {returning ? (
        <div className="grid gap-2">
          <Textarea
            aria-label="Why it goes back"
            placeholder="What the master should answer before it asks again"
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
              onClick={() => send({ decision: "return", reason: reason.trim() })}
            >
              Return with reason
            </Button>
          </span>
        </div>
      ) : null}
      {decide.isError ? <p className="text-12 text-red">{formatApiError(decide.error)}</p> : null}
    </div>
  );
}
