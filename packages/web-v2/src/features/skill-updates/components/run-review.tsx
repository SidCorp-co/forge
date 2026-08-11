// Review pane for one reconcile run: what the agent proposes, why, what three
// independent verifiers made of it, and the exact diff — then approve or reject.

"use client";

import { useMemo, useState } from "react";
import { Badge, Button, ErrorState, Field, Skeleton, Textarea } from "@/design";
import { formatApiError } from "@/lib/api/error";
import { diffLines, diffStat, withContext } from "../diff";
import {
  useAcknowledgeReconcileRun,
  useApplyReconcileRun,
  useReconcileRun,
  useRejectReconcileRun,
} from "../hooks";

export interface RunReviewProps {
  projectId: string;
  runId: string;
  canManage: boolean;
}

export function RunReview({ projectId, runId, canManage }: RunReviewProps) {
  const { data: run, isLoading, isError, error, refetch } = useReconcileRun(projectId, runId);
  const apply = useApplyReconcileRun(projectId);
  const reject = useRejectReconcileRun(projectId);
  const acknowledge = useAcknowledgeReconcileRun(projectId);
  const [confirming, setConfirming] = useState<"apply" | "reject" | "acknowledge" | null>(null);
  const [rejectReason, setRejectReason] = useState("");

  const lines = useMemo(
    () => diffLines(run?.lastGoodBody ?? "", run?.candidateBody ?? ""),
    [run?.lastGoodBody, run?.candidateBody],
  );
  const stat = useMemo(() => diffStat(lines), [lines]);
  const shown = useMemo(() => withContext(lines), [lines]);

  if (isLoading) {
    return (
      <div className="space-y-3 p-4">
        <Skeleton className="h-5 w-48" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (isError || !run) {
    return (
      <div className="p-4">
        <ErrorState message={formatApiError(error)} onRetry={() => refetch()} />
      </div>
    );
  }

  const waiting = run.status === "decided" && run.gate === "human";
  const escalatedNeedsAck =
    run.status === "escalated" && run.verdict === "escalate" && !run.acknowledgedAt;
  const votes = run.verifierVotes ?? [];
  const passes = votes.filter((v) => v.vote === "pass").length;
  const busy = apply.isPending || reject.isPending || acknowledge.isPending;

  return (
    <div className="flex min-h-0 flex-col gap-4 p-4">
      <header className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <Badge>{run.verdict ?? run.status}</Badge>
          {run.gate ? <Badge tone={run.gate === "human" ? "amber" : "neutral"}>{run.gate} gate</Badge> : null}
          {votes.length > 0 ? (
            <Badge tone={passes === votes.length ? "green" : "red"}>
              {passes}/{votes.length} verifiers passed
            </Badge>
          ) : null}
          <span className="text-muted text-sm">
            +{stat.added} / −{stat.removed} lines
          </span>
        </div>
        {run.bundle?.story ? (
          <p className="text-muted max-w-prose text-sm">{run.bundle.story}</p>
        ) : null}
      </header>

      {run.rationale ? (
        <section>
          <h3 className="mb-1 text-sm font-medium">Why the agent decided this</h3>
          <p className="text-muted max-w-prose whitespace-pre-wrap text-sm">{run.rationale}</p>
        </section>
      ) : null}

      {votes.length > 0 ? (
        <section>
          <h3 className="mb-1 text-sm font-medium">Verifiers</h3>
          <ul className="space-y-2">
            {votes.map((v) => (
              <li key={v.jobId} className="border-line rounded-r border-l-2 pl-3 text-sm">
                <Badge tone={v.vote === "pass" ? "green" : "red"}>{v.vote}</Badge>
                <p className="text-muted mt-1">{v.reason}</p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="min-h-0">
        <h3 className="mb-1 text-sm font-medium">Changes to the running skill body</h3>
        {stat.added === 0 && stat.removed === 0 ? (
          <p className="text-muted text-sm">No change to the body.</p>
        ) : (
          <div className="border-line max-h-[50vh] overflow-auto rounded border">
            <pre className="min-w-full text-xs leading-relaxed">
              {shown.map((l, idx) =>
                l === null ? (
                  // biome-ignore lint/suspicious/noArrayIndexKey: diff rows have no stable id
                  <div key={idx} className="text-muted bg-hover px-3 py-1">
                    ⋯
                  </div>
                ) : (
                  <div
                    // biome-ignore lint/suspicious/noArrayIndexKey: diff rows have no stable id
                    key={idx}
                    className={
                      l.kind === "added"
                        ? "bg-[var(--green-50)] text-fg px-3"
                        : l.kind === "removed"
                          ? "bg-[var(--red-50)] text-fg px-3"
                          : "text-muted px-3"
                    }
                  >
                    <span className="select-none opacity-60">
                      {l.kind === "added" ? "+" : l.kind === "removed" ? "−" : " "}{" "}
                    </span>
                    {l.text || " "}
                  </div>
                ),
              )}
            </pre>
          </div>
        )}
      </section>

      {waiting ? (
        canManage ? (
          <footer className="border-line space-y-3 border-t pt-3">
            {confirming === "reject" ? (
              <div className="space-y-2">
                <Field label="Why are you rejecting this?">
                  <Textarea
                    value={rejectReason}
                    onChange={(e) => setRejectReason(e.target.value)}
                    placeholder="The agent and the audit log both keep this reason."
                    rows={3}
                  />
                </Field>
                <div className="flex gap-2">
                  <Button
                    variant="danger"
                    loading={reject.isPending}
                    disabled={rejectReason.trim().length === 0}
                    onClick={() =>
                      reject.mutate(
                        { runId, reason: rejectReason.trim() },
                        { onSuccess: () => setConfirming(null) },
                      )
                    }
                  >
                    Reject update
                  </Button>
                  <Button variant="ghost" onClick={() => setConfirming(null)} disabled={busy}>
                    Cancel
                  </Button>
                </div>
              </div>
            ) : confirming === "apply" ? (
              <div className="space-y-2">
                <p className="text-sm">
                  This publishes the new body to every runner on the project. There is no automatic
                  revert — undoing it means restoring the previous body by hand.
                </p>
                <div className="flex gap-2">
                  <Button
                    variant="primary"
                    loading={apply.isPending}
                    onClick={() => apply.mutate(runId, { onSuccess: () => setConfirming(null) })}
                  >
                    Publish to runners
                  </Button>
                  <Button variant="ghost" onClick={() => setConfirming(null)} disabled={busy}>
                    Cancel
                  </Button>
                </div>
              </div>
            ) : (
              <div className="flex gap-2">
                <Button variant="primary" onClick={() => setConfirming("apply")}>Approve</Button>
                <Button variant="danger" onClick={() => setConfirming("reject")}>
                  Reject
                </Button>
              </div>
            )}
          </footer>
        ) : (
          <footer className="border-line border-t pt-3">
            <p className="text-muted text-sm">
              Waiting on a project admin — you have read access to this review.
            </p>
          </footer>
        )
      ) : escalatedNeedsAck ? (
        canManage ? (
          <footer className="border-line space-y-3 border-t pt-3">
            {confirming === "acknowledge" ? (
              <div className="space-y-2">
                <p className="text-sm">
                  This clears the attention item without changing the skill body — use it once
                  you've handled the escalation some other way.
                </p>
                <div className="flex gap-2">
                  <Button
                    variant="primary"
                    loading={acknowledge.isPending}
                    onClick={() =>
                      acknowledge.mutate(
                        { runId },
                        { onSuccess: () => setConfirming(null) },
                      )
                    }
                  >
                    Acknowledge
                  </Button>
                  <Button variant="ghost" onClick={() => setConfirming(null)} disabled={busy}>
                    Cancel
                  </Button>
                </div>
              </div>
            ) : (
              <Button variant="primary" onClick={() => setConfirming("acknowledge")}>
                Acknowledge
              </Button>
            )}
          </footer>
        ) : (
          <footer className="border-line border-t pt-3">
            <p className="text-muted text-sm">
              Escalated — waiting on a project admin to acknowledge.
            </p>
          </footer>
        )
      ) : null}
    </div>
  );
}
