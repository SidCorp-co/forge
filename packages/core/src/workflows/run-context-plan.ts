// What a run is told about the plan it holds against the requirement: re-pinned onto newly
// approved designs since the plan (ISS-86), another revision, current, or not yet planned
export function planLine(
  changed: boolean,
  plannedRevision: number | null,
  currentRevision: number,
): string {
  if (changed && plannedRevision === currentRevision) {
    return `REQUIREMENT_CHANGED_SINCE_PLAN: revision ${currentRevision} was re-pinned onto newly approved designs after this issue's plan was written; re-plan against the pins below before building.`;
  }
  if (changed) {
    return `REQUIREMENT_CHANGED_SINCE_PLAN: this issue's plan was written against ${plannedRevision === null ? 'no revision' : `revision ${plannedRevision}`}; re-plan against revision ${currentRevision} before building.`;
  }
  return plannedRevision === null
    ? `No plan has been written against it yet; a plan written now records revision ${currentRevision}.`
    : `This issue's plan was written against revision ${plannedRevision}, the current one.`;
}

export const fetchLine = (workflowId: string, revision: number | null) =>
  `\`forge-runner api projects/<projectId>/workflows/${workflowId}/design?view=steps${revision === null ? '' : `&revision=${revision}`}\``;
