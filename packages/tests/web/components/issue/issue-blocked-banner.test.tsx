import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { createElement } from 'react';
import { IssueBlockedBanner } from '@/components/issue/issue-blocked-banner';

interface Edge {
  id: string;
  fromIssueId: string;
  toIssueId: string;
  kind: 'blocks';
  projectId: string;
  reason: null;
  validUntil: null;
  createdById: null;
  createdAt: string;
}

const state = vi.hoisted(() => ({
  blockerEdges: [] as Array<{
    id: string;
    fromIssueId: string;
    toIssueId: string;
    kind: 'blocks';
    projectId: string;
    reason: null;
    validUntil: null;
    createdById: null;
    createdAt: string;
  }>,
  blockerIssues: [] as Array<{ id: string; displayId: string; status: string } | undefined>,
}));

vi.mock('@/features/issue/hooks/use-issue-relations', () => ({
  useIssueRelations: () => ({
    groups: {
      blocks: { outgoing: [], incoming: state.blockerEdges },
      relates: { outgoing: [], incoming: [] },
      duplicates: { outgoing: [], incoming: [] },
      parent: { outgoing: [], incoming: [] },
    },
    total: state.blockerEdges.length,
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  }),
}));

vi.mock('@tanstack/react-query', () => ({
  useQueries: ({ queries }: { queries: Array<{ enabled?: boolean }> }) =>
    queries.map((_, i) => ({
      data: state.blockerIssues[i],
      isLoading: false,
      error: null,
    })),
}));

vi.mock('@/features/issue/hooks/use-issues', () => ({
  issueKeys: {
    detail: (id: string | undefined) => ['issue', id] as const,
  },
}));

vi.mock('@/features/issue/api/issue-api', () => ({
  issueApi: { get: vi.fn() },
}));

function makeEdge(id: string, fromIssueId: string): Edge {
  return {
    id,
    fromIssueId,
    toIssueId: 'current-uuid',
    kind: 'blocks',
    projectId: 'p',
    reason: null,
    validUntil: null,
    createdById: null,
    createdAt: '2026-01-01',
  };
}

function renderBanner() {
  return render(createElement(IssueBlockedBanner, { issueId: 'i' }));
}

beforeEach(() => {
  state.blockerEdges = [];
  state.blockerIssues = [];
});

// Skipped: shared web test infra (React 19 vs jsdom render mismatch) — see
// vitest.config.ts exclude list. Re-enable when the harness is stabilised.
describe.skip('IssueBlockedBanner', () => {
  it('renders nothing when there are no blockers', () => {
    const { container } = renderBanner();
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when all blockers are closed', () => {
    state.blockerEdges = [makeEdge('e1', 'b1'), makeEdge('e2', 'b2')];
    state.blockerIssues = [
      { id: 'b1', displayId: 'ISS-1', status: 'released' },
      { id: 'b2', displayId: 'ISS-2', status: 'closed' },
    ];
    const { container } = renderBanner();
    expect(container.firstChild).toBeNull();
  });

  it('renders singular copy for exactly one open blocker', () => {
    state.blockerEdges = [makeEdge('e1', 'b1')];
    state.blockerIssues = [{ id: 'b1', displayId: 'ISS-7', status: 'open' }];
    renderBanner();
    expect(screen.getByText('ISS-7')).toBeInTheDocument();
    expect(screen.getByText(/Blocked by/)).toBeInTheDocument();
    expect(screen.getByText(/\(status: open\)/)).toBeInTheDocument();
    expect(screen.queryByText(/other\(s\)/)).toBeNull();
  });

  it('renders plural copy for three open blockers', () => {
    state.blockerEdges = [
      makeEdge('e1', 'b1'),
      makeEdge('e2', 'b2'),
      makeEdge('e3', 'b3'),
    ];
    state.blockerIssues = [
      { id: 'b1', displayId: 'ISS-7', status: 'open' },
      { id: 'b2', displayId: 'ISS-8', status: 'in_progress' },
      { id: 'b3', displayId: 'ISS-9', status: 'open' },
    ];
    renderBanner();
    expect(screen.getByText('ISS-7')).toBeInTheDocument();
    expect(screen.getByText(/and 2 other\(s\)/)).toBeInTheDocument();
  });

  it('skips closed blockers when counting "others"', () => {
    state.blockerEdges = [
      makeEdge('e1', 'b1'),
      makeEdge('e2', 'b2'),
      makeEdge('e3', 'b3'),
    ];
    state.blockerIssues = [
      { id: 'b1', displayId: 'ISS-7', status: 'open' },
      { id: 'b2', displayId: 'ISS-8', status: 'released' },
      { id: 'b3', displayId: 'ISS-9', status: 'in_progress' },
    ];
    renderBanner();
    expect(screen.getByText(/and 1 other\(s\)/)).toBeInTheDocument();
  });

  it('scrolls to #issue-relations when clicked', () => {
    state.blockerEdges = [makeEdge('e1', 'b1')];
    state.blockerIssues = [{ id: 'b1', displayId: 'ISS-7', status: 'open' }];

    const target = document.createElement('section');
    target.id = 'issue-relations';
    document.body.appendChild(target);

    const scrollSpy = vi.fn();
    target.scrollIntoView = scrollSpy;

    renderBanner();
    fireEvent.click(screen.getByRole('button', { name: 'Scroll to relations' }));
    expect(scrollSpy).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' });

    document.body.removeChild(target);
  });
});
