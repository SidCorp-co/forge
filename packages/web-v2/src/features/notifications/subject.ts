interface Subject {
  type: string;
  projectSlug: string | null;
  issueId: string | null;
}

/** The page a notification is about, or null where it names no project to open. */
export function subjectHref({ type, projectSlug, issueId }: Subject): string | null {
  if (!projectSlug) return null;
  if (type === "reconcile_gate_pending") return `/projects/${projectSlug}/library?tab=updates`;
  if (issueId) return `/projects/${projectSlug}/issues/${issueId}`;
  return `/projects/${projectSlug}`;
}

export function secondaryHref(row: {
  projectSlug: string | null;
  secondaryIssueId: string | null;
}): string | null {
  if (!row.projectSlug || !row.secondaryIssueId) return null;
  return `/projects/${row.projectSlug}/issues/${row.secondaryIssueId}`;
}
