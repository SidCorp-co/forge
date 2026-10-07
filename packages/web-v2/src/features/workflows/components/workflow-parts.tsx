"use client";

import type { SensitiveDataLevel } from "@forge/contracts/data-policy";
import { StatusBadge, statusReading, Tooltip, WaitingOn } from "@/design";
import { TONE_META } from "@/design/status";
import { useCopy, useInterfaceLanguage } from "@/lib/i18n/interface-language";
import type { IntegrationState } from "../types";
import type { DesignStatus, WorkflowRecord } from "../types";

/** A design's approval state: the shared design badge, the return reason in its tooltip. */
export function DesignPill({ status, reason }: { status: DesignStatus; reason?: string | null }) {
  const language = useInterfaceLanguage();
  const badge = <StatusBadge family="design" value={status} />;
  return reason ? (
    <Tooltip label={`${statusReading("design", status, language).hint ?? ""}: ${reason}`} side="bottom" multiline>
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
  const t = useCopy();
  const pending = r.design.pendingRevision;
  if (pending === null) return null;
  return (
    <Tooltip label={t("workflows.proposedMarkerHint", { pending, approved: r.design.approvedRevision ?? "" })} side="bottom" multiline>
      <span className="whitespace-nowrap font-mono text-11-5 font-semibold" style={{ color: TONE_META.attention.fg }} data-testid="proposed-marker">
        {t("workflows.proposedMarker", { r: pending })}
      </span>
    </Tooltip>
  );
}

/** Whom a design waits on and for what, as core's list reading says (`design-standing.ts:designWaitingOn`);
 *  nothing for a design nobody owes a step on. */
export function DesignWaits({ r }: { r: WorkflowRecord }) {
  const w = r.design.waitingOn;
  if (w.kind === "none") return null;
  return <WaitingOn w={w} />;
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
  const language = useInterfaceLanguage();
  const badge = (
    <span data-testid="integration-badge" data-state={state}>
      <StatusBadge family="integration" value={state} />
    </span>
  );
  return mark ? (
    <Tooltip label={`${statusReading("integration", state, language).label}: “${mark}”`} side="bottom" multiline>
      {badge}
    </Tooltip>
  ) : (
    badge
  );
}
