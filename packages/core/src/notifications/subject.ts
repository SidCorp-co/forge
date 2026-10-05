import type { IssueStatus } from '@forge/contracts/issue-machine';
import { ISSUE_STATUS_LABELS } from '@forge/contracts/issue-vocabulary';
import type { NotificationSubject } from '@forge/contracts/notifications';

export function statusWords(status: string): string {
  const label = ISSUE_STATUS_LABELS[status as IssueStatus];
  return label ? label.toLowerCase() : status;
}

/** A grouped delivery names its project: the issue on any one member is not the delivery's. */
export function deliverySubject(
  row: { members: number; issueId: string | null; projectId: string | null },
  issueKeys: ReadonlyMap<string, string>,
  projectSlugs: ReadonlyMap<string, string>,
): NotificationSubject | null {
  const issueKey = row.members === 1 && row.issueId ? issueKeys.get(row.issueId) : undefined;
  if (row.issueId && issueKey) return { kind: 'issue', key: issueKey, id: row.issueId };
  const slug = row.projectId ? projectSlugs.get(row.projectId) : undefined;
  if (row.projectId && slug) return { kind: 'project', key: slug, id: row.projectId };
  return null;
}

const LEAD = /^\s*[—:-]?\s*/;

export function deliveryLine(title: string, subjectKey: string | null): string {
  let line = title;
  if (subjectKey && line.startsWith(subjectKey)) {
    const rest = line.slice(subjectKey.length).replace(LEAD, '');
    if (rest) line = rest;
  }
  return line;
}
