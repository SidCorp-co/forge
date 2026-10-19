interface Subject {
  type: string;
  projectSlug: string | null;
  issueId: string | null;
}

/** The page a notification is about; a platform alert opens the ops page, and none else names nowhere. */
export function subjectHref({ type, projectSlug, issueId }: Subject): string | null {
  if (!projectSlug) return type === "ops_alert" ? "/ops" : null;
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

interface Member {
  projectId: string | null;
  projectSlug: string | null;
  projectName: string | null;
  title: string;
}

/**
 * What each record of a group reads as. Two projects number their issues alike, so a group spanning
 * projects carries the project's name on every member, or its slug where two share a name, unless
 * the title already ends by saying it.
 */
export function memberTexts(members: readonly Member[]): string[] {
  const projects = new Map<string, Member>();
  for (const m of members) if (m.projectId) projects.set(m.projectId, m);
  if (projects.size < 2) return members.map((m) => m.title);
  const names = [...projects.values()].map((m) => m.projectName ?? m.projectSlug);
  const unique = new Set(names).size === names.length;
  return members.map((m) => {
    const tag = unique ? (m.projectName ?? m.projectSlug) : (m.projectSlug ?? m.projectName);
    return tag && !m.title.toLowerCase().endsWith(` — ${tag.toLowerCase()}`) ? `${tag} · ${m.title}` : m.title;
  });
}
