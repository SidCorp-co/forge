// Where a notification's subject opens. One function, so the bell, the inbox and a grouped
// row's members agree: a row that names something opens it, and a row that names nothing
// openable is plain text rather than a link that goes nowhere.

interface Subject {
  type: string;
  projectSlug: string | null;
  issueId: string | null;
}

/**
 * The page a notification is about: its issue, else the skill updates a reconcile gate is
 * waiting on, else its project. Null where it names no project, which is the only case with
 * nowhere to go.
 */
export function subjectHref({ type, projectSlug, issueId }: Subject): string | null {
  if (!projectSlug) return null;
  if (type === "reconcile_gate_pending") return `/projects/${projectSlug}/library?tab=updates`;
  if (issueId) return `/projects/${projectSlug}/issues/${issueId}`;
  return `/projects/${projectSlug}`;
}

/** The blocker or child a dependency-stall wedge is actually waiting on, where it differs. */
export function secondaryHref(row: {
  projectSlug: string | null;
  secondaryIssueId: string | null;
}): string | null {
  if (!row.projectSlug || !row.secondaryIssueId) return null;
  return `/projects/${row.projectSlug}/issues/${row.secondaryIssueId}`;
}
