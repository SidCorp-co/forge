import type { NotificationSubject } from '@forge/contracts';
import { ISSUE_STATUS_LABELS, type KernelIssueStatus } from '@forge/contracts/issue-vocabulary';

/** A kernel status as words inside a sentence: `awaiting_release` → "awaiting release". */
export function statusWords(status: string): string {
  const label = ISSUE_STATUS_LABELS[status as KernelIssueStatus];
  return label ? label.toLowerCase() : status;
}

/**
 * What one delivery names: the issue its single record references, else the project it belongs to.
 * A delivery grouping several records names its project, because the issue on any one member is
 * not the delivery's.
 */
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
const MOVED_TO = /moved to ([a-z_]+)$/;

/**
 * The delivery's one line beside its subject key: the stored title without the key it opens with,
 * and with a status change's raw status read as words.
 */
// cm:hack ISS-74 until:no stored notification title predates `notify-transitions.ts` writing the status as words — a title stored before that change still ends "moved to awaiting_release", and the bell reads it here rather than show a raw value
export function deliveryLine(title: string, type: string, subjectKey: string | null): string {
  let line = title;
  if (subjectKey && line.startsWith(subjectKey)) {
    const rest = line.slice(subjectKey.length).replace(LEAD, '');
    if (rest) line = rest;
  }
  if (type === 'issue_status_changed') {
    line = line.replace(MOVED_TO, (_, status: string) => `moved to ${statusWords(status)}`);
  }
  return line;
}
