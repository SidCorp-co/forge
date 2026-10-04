"use client";

import { useRef, useState } from "react";
import { Button, Field, Popover, Textarea } from "@/design";
import { useCutRelease, useReleaseDecision } from "../hooks";
import type { ReleaseDetail } from "../types";
import { RefusalText } from "./release-bits";

function ReturnWithReason({ projectId, runId, approvalId }: { projectId: string; runId: string; approvalId: string }) {
  const decide = useReleaseDecision(projectId);
  const anchor = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  return (
    <>
      <span ref={anchor} className="inline-flex">
        <Button type="button" size="sm" aria-expanded={open} onClick={() => setOpen((o) => !o)} data-testid="release-return">
          Return with reason
        </Button>
      </span>
      <Popover open={open} anchor={anchor} onDismiss={() => setOpen(false)} placement="bottom-end" takesFocus className="w-[320px] bg-surface p-3 shadow-md">
        <form
          className="grid gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            decide.mutate(
              { runId, approvalId, body: { decision: "return", reason: reason.trim() } },
              {
                onSuccess: () => {
                  setOpen(false);
                  setReason("");
                },
              },
            );
          }}
        >
          <Field label="Why it goes back">
            <Textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              placeholder="What the master should answer before it asks again"
              data-testid="release-return-reason"
            />
          </Field>
          <RefusalText error={decide.error} />
          <span className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" size="sm" disabled={!reason.trim()} loading={decide.isPending}>
              Return with reason
            </Button>
          </span>
        </form>
      </Popover>
    </>
  );
}

export function ReleaseActions({ projectId, r }: { projectId: string; r: ReleaseDetail }) {
  const decide = useReleaseDecision(projectId);
  const cut = useCutRelease(projectId);
  const decision = r.can.decide && r.approval && r.runId ? { runId: r.runId, approvalId: r.approval.id } : null;
  if (!decision && !r.can.cut) return null;
  return (
    <span className="flex flex-wrap items-center gap-2" data-testid="release-actions">
      {decision ? (
        <>
          <ReturnWithReason projectId={projectId} {...decision} />
          <Button
            type="button"
            size="sm"
            variant="primary"
            loading={decide.isPending}
            onClick={() => decide.mutate({ ...decision, body: { decision: "approve" } })}
            data-testid="release-approve"
          >
            Approve release
          </Button>
          <RefusalText error={decide.error} />
        </>
      ) : (
        <>
          <Button
            type="button"
            size="sm"
            variant="primary"
            loading={cut.isPending}
            onClick={() => cut.mutate(r.issues.map((i) => i.id))}
            data-testid="release-cut"
          >
            Cut {r.version}
          </Button>
          <RefusalText error={cut.error} />
        </>
      )}
    </span>
  );
}
