import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import * as React from 'react';
void React;

const { useIssueDependencies, useIssue } = vi.hoisted(() => ({
  useIssueDependencies: vi.fn(),
  useIssue: vi.fn(),
}));

vi.mock('@/features/issue/hooks/use-issue-dependencies', () => ({
  useIssueDependencies,
}));

vi.mock('@/features/issue/hooks/use-issues', () => ({
  useIssue,
}));

import { IssueDecompositionPanel } from '@/components/issue/issue-decomposition-panel';

function dep(overrides: Partial<{ id: string; toIssueId: string; kind: string }> = {}) {
  return {
    id: overrides.id ?? 'edge-1',
    projectId: 'p-1',
    fromIssueId: 'parent-1',
    toIssueId: overrides.toIssueId ?? 'child-1',
    kind: overrides.kind ?? 'decomposes',
    reason: null,
    validUntil: null,
    createdById: null,
    createdAt: new Date().toISOString(),
  };
}

beforeEach(() => {
  useIssueDependencies.mockReset();
  useIssue.mockReset();
});

describe('IssueDecompositionPanel', () => {
  it('returns null while dependencies are loading', () => {
    useIssueDependencies.mockReturnValue({ isLoading: true, data: undefined });
    const { container } = render(
      <IssueDecompositionPanel issueId="parent-1" projectSlug="acme" />,
    );
    expect(container.innerHTML).toBe('');
  });

  it('returns null when there are no decomposes edges', () => {
    useIssueDependencies.mockReturnValue({
      isLoading: false,
      data: { outgoing: [dep({ kind: 'blocks' })], incoming: [] },
    });
    const { container } = render(
      <IssueDecompositionPanel issueId="parent-1" projectSlug="acme" />,
    );
    expect(container.innerHTML).toBe('');
  });

  it('renders one row per decomposition child with ISS-N link and status dot', () => {
    useIssueDependencies.mockReturnValue({
      isLoading: false,
      data: {
        outgoing: [
          dep({ id: 'e1', toIssueId: 'child-1' }),
          dep({ id: 'e2', toIssueId: 'child-2' }),
          dep({ id: 'e3', toIssueId: 'child-3' }),
        ],
        incoming: [],
      },
    });
    useIssue.mockImplementation((id: string | undefined) => ({
      isLoading: false,
      data: {
        displayId:
          id === 'child-1' ? 'ISS-101' : id === 'child-2' ? 'ISS-102' : 'ISS-103',
        title: `Child ${id}`,
        status:
          id === 'child-1' ? 'staging' : id === 'child-2' ? 'developed' : 'approved',
      },
    }));

    render(<IssueDecompositionPanel issueId="parent-1" projectSlug="acme" />);
    expect(screen.getByText(/Decomposition children \(3\)/i)).toBeDefined();
    expect(screen.getByText('ISS-101')).toBeDefined();
    expect(screen.getByText('ISS-102')).toBeDefined();
    expect(screen.getByText('ISS-103')).toBeDefined();
    expect(screen.getAllByLabelText('staging').length).toBeGreaterThan(0);
  });

  it('ignores non-decomposes edges in the outgoing list', () => {
    useIssueDependencies.mockReturnValue({
      isLoading: false,
      data: {
        outgoing: [
          dep({ id: 'e1', toIssueId: 'child-1', kind: 'decomposes' }),
          dep({ id: 'e2', toIssueId: 'other-1', kind: 'blocks' }),
        ],
        incoming: [],
      },
    });
    useIssue.mockImplementation((id: string | undefined) => ({
      isLoading: false,
      data: { displayId: 'ISS-101', title: `Child ${id}`, status: 'staging' },
    }));

    render(<IssueDecompositionPanel issueId="parent-1" projectSlug="acme" />);
    expect(screen.getByText(/Decomposition children \(1\)/i)).toBeDefined();
  });
});
