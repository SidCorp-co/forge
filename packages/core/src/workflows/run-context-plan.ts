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

/**
 * Where a run reads the whole of a design it was given cut. One its issue's requirement pins reads
 * through the issue, so it holds where that requirement and its designs are a sibling project's,
 * outside the run's credential; one the issue builds is its own project's.
 */
export const fetchLine = (workflowId: string, revision: number | null, issueId?: string | null) =>
  issueId
    ? `\`forge-runner api issues/${issueId}/requirement/designs/${workflowId}${revision === null ? '' : `?revision=${revision}`}\``
    : `\`forge-runner api projects/<projectId>/workflows/${workflowId}/design?view=steps${revision === null ? '' : `&revision=${revision}`}\``;
