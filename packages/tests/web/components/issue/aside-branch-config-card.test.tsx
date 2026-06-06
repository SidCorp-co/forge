import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { BranchConfigCard } from '@/components/issue/aside/branch-config-card';
import type { Issue } from '@forge/contracts';

void React;

vi.mock('@/features/project/hooks/use-projects', () => ({
  useProjectBySlug: () => ({
    id: 'p-1',
    slug: 'p',
    baseBranch: 'develop',
    productionBranch: 'release',
  }),
}));

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  // The fields the card actually touches; the rest are filled with
  // unused placeholder values. `as Issue` is safe because the component
  // doesn't introspect other columns.
  return {
    id: 'i-1',
    projectId: 'p-1',
    issSeq: 137,
    displayId: 'ISS-137',
    title: 't',
    description: null,
    status: 'open',
    priority: 'medium',
    category: null,
    reportedBy: null,
    complexity: null,
    plan: null,
    acceptanceCriteria: null,
    suggestedSolution: null,
    sessionContext: null,
    aiSummary: null,
    aiSuggestedSolution: null,
    aiAcceptanceCriteria: null,
    aiConfidence: null,
    failureContext: null,
    metadata: null,
    assigneeId: null,
    createdById: 'u-1',
    parentIssueId: null,
    reopenCount: 0,
    source: 'manual',
    externalId: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  } as unknown as Issue;
}

describe('BranchConfigCard', () => {
  let onPatch: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    onPatch = vi.fn().mockResolvedValue(undefined);
  });

  it('collapsed by default; summary shows resolved values + from-project badge when no override', () => {
    render(
      <BranchConfigCard issue={makeIssue()} projectSlug="p" onPatch={onPatch} />,
    );
    expect(screen.getByText(/base: develop/)).toBeInTheDocument();
    expect(screen.getByText(/prod: release/)).toBeInTheDocument();
    expect(screen.getByText(/from project/i)).toBeInTheDocument();
  });

  it('expand shows read-only resolved rows when override is off', () => {
    render(
      <BranchConfigCard issue={makeIssue()} projectSlug="p" onPatch={onPatch} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /branch config/i }));
    expect(screen.getByText('Base branch')).toBeInTheDocument();
    expect(screen.getByText('Target branch')).toBeInTheDocument();
    expect(screen.getByText('Prod branch')).toBeInTheDocument();
    expect(screen.getAllByText(/from project/i).length).toBeGreaterThanOrEqual(3);
  });

  it('toggling override on prefills inputs from existing metadata', () => {
    const issue = makeIssue({
      metadata: {
        branchConfig: { baseBranch: 'feat/x', targetBranch: 'feat/y', prodBranch: null },
      },
    } as Partial<Issue>);
    render(<BranchConfigCard issue={issue} projectSlug="p" onPatch={onPatch} />);
    fireEvent.click(screen.getByRole('button', { name: /branch config/i }));
    // Already override mode because metadata is present.
    expect(screen.getByDisplayValue('feat/x')).toBeInTheDocument();
    expect(screen.getByDisplayValue('feat/y')).toBeInTheDocument();
  });

  it('save with override sends a PATCH with the entered values; blanks become null', async () => {
    render(
      <BranchConfigCard issue={makeIssue()} projectSlug="p" onPatch={onPatch} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /branch config/i }));
    fireEvent.click(screen.getByLabelText(/Override project branch config/i));
    // base + target both placeholder 'develop' (target falls back to base);
    // index 0 is base.
    const branchInputs = screen.getAllByPlaceholderText('develop');
    fireEvent.change(branchInputs[0]!, { target: { value: 'feat/x' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    expect(onPatch).toHaveBeenCalledWith('i-1', {
      metadata: {
        branchConfig: { baseBranch: 'feat/x', targetBranch: null, prodBranch: null },
      },
    });
  });

  it('turning off an existing override sends PATCH with metadata.branchConfig = null', async () => {
    const issue = makeIssue({
      metadata: { branchConfig: { baseBranch: 'feat/x' } },
    } as Partial<Issue>);
    render(<BranchConfigCard issue={issue} projectSlug="p" onPatch={onPatch} />);
    fireEvent.click(screen.getByRole('button', { name: /branch config/i }));
    fireEvent.click(screen.getByLabelText(/Override project branch config/i));
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    expect(onPatch).toHaveBeenCalledWith('i-1', {
      metadata: { branchConfig: null },
    });
  });
});
