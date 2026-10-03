"use client";

import { Tooltip } from "@/design";
import { TONE_META } from "@/design/status";
import type { DesignStatus, WorkflowRecord } from "../types";

const DESIGN_PILL: Record<DesignStatus, { label: string; tone: keyof typeof TONE_META; tip: string }> = {
  draft: { label: "Draft", tone: "infra", tip: "The master is still drawing it; nobody has been asked to approve it" },
  proposed: { label: "Awaiting approval", tone: "attention", tip: "Nothing that builds it is dispatched until it is approved" },
  approved: { label: "Approved", tone: "success", tip: "Work that builds it may start" },
  returned: { label: "Returned", tone: "failure", tip: "Sent back to the master to revise" },
};

/** A design's approval state as a colour badge: a dot and a sentence-case label, the meaning in its tooltip. */
export function DesignPill({ status, reason }: { status: DesignStatus; reason?: string | null }) {
  const p = DESIGN_PILL[status];
  const c = TONE_META[p.tone];
  return (
    <Tooltip label={reason ? `${p.tip}: ${reason}` : p.tip} side="bottom" multiline>
      <span
        className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-pill px-2 py-0.5 text-11 font-semibold"
        style={{ color: c.fg, background: c.bg }}
        data-testid="design-pill"
        data-status={status}
      >
        <span aria-hidden className="size-1.5 rounded-full" style={{ background: c.dot }} />
        {p.label}
      </span>
    </Tooltip>
  );
}

/** A newer revision waiting on its approver while an older one stays the approved design; nothing when there is none. */
export function ProposedMarker({ r }: { r: WorkflowRecord }) {
  const approved = r.design.approvedRevision;
  if (r.design.status !== "proposed" || approved === null || r.revision <= approved) return null;
  return (
    <Tooltip label={`Revision ${r.revision} is waiting on its approver; revision ${approved} stays the approved design until then`} side="bottom" multiline>
      <span className="whitespace-nowrap font-mono text-11-5 font-semibold" style={{ color: TONE_META.attention.fg }} data-testid="proposed-marker">
        r{r.revision} proposed
      </span>
    </Tooltip>
  );
}
