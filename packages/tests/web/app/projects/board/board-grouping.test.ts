import { describe, expect, it } from 'vitest';
import {
  bucketIssues,
  rowLabelFor,
  rowValueFor,
  UNGROUPED_ROW_KEY,
} from '@/app/projects/[slug]/board/hooks/board-grouping';

const issues = [
  { id: '1', assigneeId: 'alice', parentIssueId: null, category: 'ui' },
  { id: '2', assigneeId: 'bob', parentIssueId: 'p1', category: 'ui' },
  { id: '3', assigneeId: null, parentIssueId: null, category: null },
  { id: '4', assigneeId: 'alice', parentIssueId: 'p1', category: 'backend' },
];

describe('bucketIssues', () => {
  it('returns a single ungrouped bucket when groupBy=none', () => {
    const rows = bucketIssues(issues, 'none');
    expect(rows).toHaveLength(1);
    expect(rows[0].rowKey).toBe(UNGROUPED_ROW_KEY);
    expect(rows[0].issues).toHaveLength(4);
  });

  it('buckets by assignee with null bucket last', () => {
    const rows = bucketIssues(issues, 'assignee');
    expect(rows.map((r) => r.rowKey)).toEqual(['alice', 'bob', UNGROUPED_ROW_KEY]);
    expect(rows[0].issues).toHaveLength(2);
    expect(rows[2].rowLabel).toBe('Unassigned');
  });

  it('buckets by parent with null bucket last', () => {
    const rows = bucketIssues(issues, 'parent');
    expect(rows.map((r) => r.rowKey)).toEqual(['p1', UNGROUPED_ROW_KEY]);
    expect(rows.find((r) => r.rowKey === UNGROUPED_ROW_KEY)?.rowLabel).toBe('No parent');
  });

  it('buckets by category with null bucket last', () => {
    const rows = bucketIssues(issues, 'category');
    expect(rows.map((r) => r.rowKey)).toEqual(['backend', 'ui', UNGROUPED_ROW_KEY]);
    expect(rows.find((r) => r.rowKey === UNGROUPED_ROW_KEY)?.rowLabel).toBe('Uncategorized');
  });
});

describe('rowValueFor', () => {
  it('falls back to ungrouped sentinel when groupBy=none', () => {
    expect(rowValueFor(issues[0], 'none')).toBe(UNGROUPED_ROW_KEY);
  });

  it('reads assigneeId', () => {
    expect(rowValueFor(issues[0], 'assignee')).toBe('alice');
    expect(rowValueFor(issues[2], 'assignee')).toBe(UNGROUPED_ROW_KEY);
  });
});

describe('rowLabelFor', () => {
  it('returns the key for non-null buckets', () => {
    expect(rowLabelFor('alice', 'assignee')).toBe('alice');
  });

  it('returns localized English labels for null buckets', () => {
    expect(rowLabelFor(UNGROUPED_ROW_KEY, 'assignee')).toBe('Unassigned');
    expect(rowLabelFor(UNGROUPED_ROW_KEY, 'parent')).toBe('No parent');
    expect(rowLabelFor(UNGROUPED_ROW_KEY, 'category')).toBe('Uncategorized');
    expect(rowLabelFor(UNGROUPED_ROW_KEY, 'none')).toBe('');
  });
});
