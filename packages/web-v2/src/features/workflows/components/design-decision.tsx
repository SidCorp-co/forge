"use client";

import { useState } from "react";
import { Button, Textarea } from "@/design";
import { formatApiError } from "@/lib/api/error";
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

// cm:why Return is the secondary act, so it sits in the banner that names the turn it answers, never beside the header's Approve
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
  if (!decide.isError) return null;
  return (
    <span role="alert" className="block basis-full text-12-5 text-red" data-testid="design-decision-error">
      {formatApiError(decide.error)}
    </span>
  );
}
