"use client";

import { Badge, Tooltip } from "@/design";
import type { DesignStatus } from "../types";

const DESIGN_PILL: Record<DesignStatus, { label: string; tone: "neutral" | "amber" | "green" | "red"; tip: string }> = {
  draft: { label: "Draft", tone: "neutral", tip: "The master is still drawing it; nobody has been asked to approve it" },
  proposed: { label: "Awaiting approval", tone: "amber", tip: "Nothing that builds it is dispatched until it is approved" },
  approved: { label: "Approved", tone: "green", tip: "Work that builds it may start" },
  returned: { label: "Returned", tone: "red", tip: "Sent back to the master to revise" },
};

export function DesignPill({ status, reason }: { status: DesignStatus; reason?: string | null }) {
  const p = DESIGN_PILL[status];
  return (
    <Tooltip label={reason ? `${p.tip}: ${reason}` : p.tip} side="bottom" multiline>
      <span data-testid="design-pill" data-status={status}>
        <Badge tone={p.tone}>{p.label}</Badge>
      </span>
    </Tooltip>
  );
}
