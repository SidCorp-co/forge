"use client";

import type { SensitiveDataLevel } from "@forge/contracts/data-policy";
import { StatusBadge, statusReading, Tooltip } from "@/design";
import { TONE_META } from "@/design/status";
import type { IntegrationState } from "../types";
import type { DesignStatus, WorkflowRecord } from "../types";

/** A design's approval state: the shared design badge, the return reason in its tooltip. */
export function DesignPill({ status, reason }: { status: DesignStatus; reason?: string | null }) {
  const badge = <StatusBadge family="design" value={status} />;
  return reason ? (
    <Tooltip label={`${statusReading("design", status).hint ?? ""}: ${reason}`} side="bottom" multiline>
      <span data-testid="design-pill" data-status={status}>
        {badge}
      </span>
    </Tooltip>
  ) : (
    <span data-testid="design-pill" data-status={status}>
      {badge}
    </span>
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

/** A project's data policy as the shared badge; the level's meaning and the raw level in its tooltip. */
export function SensitivityBadge({ level }: { level: SensitiveDataLevel }) {
  return (
    <span data-testid="sensitivity-badge" data-level={level}>
      <StatusBadge family="dataPolicy" value={level} />
    </span>
  );
}

/** Whether an outside system's integration is settled, as the shared badge; the design's own words sit in its tooltip. */
export function IntegrationBadge({ state, mark }: { state: IntegrationState; mark?: string | null }) {
  const badge = (
    <span data-testid="integration-badge" data-state={state}>
      <StatusBadge family="integration" value={state} />
    </span>
  );
  return mark ? (
    <Tooltip label={`${statusReading("integration", state).label}: “${mark}”`} side="bottom" multiline>
      {badge}
    </Tooltip>
  ) : (
    badge
  );
}
