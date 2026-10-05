import type { ChangedTrace } from '@forge/contracts/requirements';

// What a run is told about the plan it holds against the requirement: a later revision changed a BC
// it traces, it names no revision, it is current, or it is not yet planned
export function planLine(
  changed: boolean,
  plannedRevision: number | null,
  currentRevision: number,
  traced: readonly ChangedTrace[] = [],
): string {
  if (changed && plannedRevision === null) {
    return `REQUIREMENT_CHANGED_SINCE_PLAN: this issue's plan names no revision; re-plan against revision ${currentRevision} before building.`;
  }
  if (changed) {
    const what = traced.map((t) => `${t.code} changed in revision ${t.revision}`).join(', ');
    return `REQUIREMENT_CHANGED_SINCE_PLAN: this issue's plan was written against revision ${plannedRevision}, and since then ${what}; re-plan against revision ${currentRevision} before building.`;
  }
  return plannedRevision === null
    ? `No plan has been written against it yet; a plan written now records revision ${currentRevision}.`
    : plannedRevision === currentRevision
      ? `This issue's plan was written against revision ${plannedRevision}, the current one.`
      : `This issue's plan was written against revision ${plannedRevision}; no BC it traces changed since, so it holds at revision ${currentRevision}.`;
}

export const fetchLine = (workflowId: string, revision: number | null) =>
  `\`forge-runner api projects/<projectId>/workflows/${workflowId}/design?view=steps${revision === null ? '' : `&revision=${revision}`}\``;
