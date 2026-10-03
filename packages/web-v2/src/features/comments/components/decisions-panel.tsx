"use client";

import { useState } from "react";
import { ActorChip, BodyView, Button, ErrorState, Input, ProjectLoader, Textarea } from "@/design";
import { formatApiError, isRetryableApiError } from "@/lib/api/error";
import { formatRelativeTime, formatStamp as stamp } from "@/lib/utils/format";
import { useEntityDecisions, usePostEntityComment } from "../hooks";
import type { EntityCommentScope, EntityCommentView } from "../types";

function Line({ label, children }: { label: string; children: string }) {
  return (
    <p className="text-13 leading-relaxed text-muted">
      <span className="font-medium text-fg">{label}</span> {children}
    </p>
  );
}

function DecisionRow({ c }: { c: EntityCommentView }) {
  const d = c.decision;
  return (
    <li className="grid gap-1.5 border-t border-line-subtle py-3.5 first:border-t-0 first:pt-0" data-testid="decision-row">
      {d ? (
        <>
          <p className="text-14 font-medium leading-snug text-fg">{d.decision}</p>
          <Line label="Why:">{d.reason}</Line>
          {d.options?.length ? <Line label="Options considered:">{d.options.join("; ")}</Line> : null}
          {d.authority ? <Line label="Authority:">{d.authority}</Line> : null}
          {d.reversedWhen ? <Line label="Reversed when:">{d.reversedWhen}</Line> : null}
        </>
      ) : c.body ? (
        <BodyView body={c.body} format={c.format} className="text-14" />
      ) : (
        <p className="text-13 text-subtle">Content withheld under this project's data policy.</p>
      )}
      <span className="mt-0.5 inline-flex items-center gap-2 text-12 text-subtle">
        <ActorChip name={c.author.name ?? "Unknown author"} kind={c.author.agency} size={16} />
        <span aria-hidden>·</span>
        <span title={stamp(c.createdAt)}>{formatRelativeTime(c.createdAt)}</span>
        {c.edited ? <span title={`Edited ${stamp(c.updatedAt)}`}>· edited</span> : null}
      </span>
    </li>
  );
}

function DecisionComposer({ projectId, scope, targetRef }: { projectId: string; scope: EntityCommentScope; targetRef: string }) {
  const post = usePostEntityComment(projectId, scope, targetRef);
  const [decision, setDecision] = useState("");
  const [reason, setReason] = useState("");
  const [options, setOptions] = useState("");
  const [authority, setAuthority] = useState("");
  const [reversedWhen, setReversedWhen] = useState("");
  const ready = decision.trim().length > 0 && reason.trim().length > 0;
  const submit = () => {
    const listed = options.split(";").map((o) => o.trim()).filter(Boolean);
    post.mutate(
      {
        intent: "decision",
        decision: {
          decision: decision.trim(),
          reason: reason.trim(),
          ...(listed.length ? { options: listed } : {}),
          ...(authority.trim() ? { authority: authority.trim() } : {}),
          ...(reversedWhen.trim() ? { reversedWhen: reversedWhen.trim() } : {}),
        },
      },
      {
        onSuccess: () => {
          for (const reset of [setDecision, setReason, setOptions, setAuthority, setReversedWhen]) reset("");
        },
      },
    );
  };
  return (
    <form
      className="grid gap-2 border-t border-line-subtle pt-4"
      data-testid="decision-composer"
      onSubmit={(e) => {
        e.preventDefault();
        if (ready) submit();
      }}
    >
      <p className="text-13 font-medium text-fg">Record a decision</p>
      <Textarea aria-label="Decision" placeholder="What was decided" rows={2} value={decision} onChange={(e) => setDecision(e.target.value)} />
      <Textarea aria-label="Reason" placeholder="Why" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
      <Input aria-label="Options considered" placeholder="Options considered, separated by ;" value={options} onChange={(e) => setOptions(e.target.value)} />
      <Input aria-label="Authority" placeholder="Authority, for example a delegation" value={authority} onChange={(e) => setAuthority(e.target.value)} />
      <Input aria-label="Reversed when" placeholder="Reversed when" value={reversedWhen} onChange={(e) => setReversedWhen(e.target.value)} />
      <span className="flex items-center gap-2">
        <Button type="submit" size="sm" variant="primary" disabled={!ready || post.isPending}>
          Record decision
        </Button>
        {post.isError ? <span className="text-12 text-red">{formatApiError(post.error)}</span> : null}
      </span>
    </form>
  );
}

export function DecisionsPanel({ projectId, scope, targetRef }: { projectId: string; scope: EntityCommentScope; targetRef: string }) {
  const q = useEntityDecisions(projectId, scope, targetRef);
  if (q.isLoading) return <ProjectLoader label="loading decisions…" />;
  if (q.isError || !q.data) {
    return <ErrorState message={formatApiError(q.error)} onRetry={isRetryableApiError(q.error) ? () => q.refetch() : undefined} />;
  }
  const rows = [...q.data.comments].reverse();
  return (
    <div className="grid gap-4" data-testid="decisions-panel">
      {rows.length ? (
        <ul className="grid">
          {rows.map((c) => (
            <DecisionRow key={c.id} c={c} />
          ))}
        </ul>
      ) : (
        <p className="text-13 text-subtle">No decisions recorded yet.</p>
      )}
      <DecisionComposer projectId={projectId} scope={scope} targetRef={targetRef} />
    </div>
  );
}
