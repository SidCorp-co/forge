import type { BoardGroupBy } from '../constants';

export const UNGROUPED_ROW_KEY = '__none__';

export interface GroupableIssue {
  id: string;
  assigneeId?: string | null;
  parentIssueId?: string | null;
  category?: string | null;
}

export interface GroupedRow<T extends GroupableIssue> {
  rowKey: string;
  rowLabel: string;
  issues: T[];
}

export function rowValueFor(issue: GroupableIssue, groupBy: BoardGroupBy): string {
  switch (groupBy) {
    case 'assignee':
      return issue.assigneeId ?? UNGROUPED_ROW_KEY;
    case 'parent':
      return issue.parentIssueId ?? UNGROUPED_ROW_KEY;
    case 'category':
      return issue.category ?? UNGROUPED_ROW_KEY;
    default:
      return UNGROUPED_ROW_KEY;
  }
}

export function rowLabelFor(key: string, groupBy: BoardGroupBy): string {
  if (key !== UNGROUPED_ROW_KEY) return key;
  switch (groupBy) {
    case 'assignee':
      return 'Unassigned';
    case 'parent':
      return 'No parent';
    case 'category':
      return 'Uncategorized';
    default:
      return '';
  }
}

export function bucketIssues<T extends GroupableIssue>(
  issues: T[],
  groupBy: BoardGroupBy,
): GroupedRow<T>[] {
  const buckets = new Map<string, T[]>();
  for (const issue of issues) {
    const key = rowValueFor(issue, groupBy);
    const arr = buckets.get(key) ?? [];
    arr.push(issue);
    buckets.set(key, arr);
  }
  if (groupBy === 'none' && buckets.size === 0) {
    buckets.set(UNGROUPED_ROW_KEY, []);
  }
  const keys = Array.from(buckets.keys());
  const realKeys = keys.filter((k) => k !== UNGROUPED_ROW_KEY).sort();
  const hasNullBucket = buckets.has(UNGROUPED_ROW_KEY);
  const ordered = hasNullBucket ? [...realKeys, UNGROUPED_ROW_KEY] : realKeys;
  return ordered.map((rowKey) => ({
    rowKey,
    rowLabel: rowLabelFor(rowKey, groupBy),
    issues: buckets.get(rowKey) ?? [],
  }));
}
