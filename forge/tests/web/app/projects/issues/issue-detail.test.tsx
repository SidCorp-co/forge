import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';
import IssueDetailPage from '@/app/projects/[slug]/issues/[id]/page';

vi.mock('next/navigation', () => ({
  useParams: () => ({ slug: 'test-project', id: 'abc-123' }),
}));

vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: { children: ReactNode; href: string }) =>
    createElement('a', { href, ...props }, children),
}));

const mockMutate = vi.fn();

vi.mock('@/features/issue/hooks/use-issues', () => ({
  useIssue: () => ({
    data: {
      data: {
        id: 1,
        documentId: 'abc-123',
        title: 'Test Issue',
        description: 'A test',
        status: 'open',
        priority: 'high',
        category: 'bug',
        reportedBy: null,
        aiSummary: 'AI summary of the issue',
        aiSuggestedSolution: 'Fix the bug',
        aiAcceptanceCriteria: ['criterion 1', 'criterion 2'],
        aiConfidence: 0.85,
        attachments: [],
        tasks: [
          { id: 1, documentId: 'task-a', title: 'Task A', status: 'done' },
          { id: 2, documentId: 'task-b', title: 'Task B', status: 'todo' },
        ],
        comments: [],
        createdAt: '2025-01-01',
        updatedAt: '2025-01-01',
      },
    },
    isLoading: false,
  }),
  useUpdateIssue: () => ({ mutate: mockMutate }),
}));

vi.mock('@/features/comment/hooks/use-comments', () => ({
  useComments: () => ({ data: { data: [] } }),
  useCreateComment: () => ({ mutate: vi.fn() }),
}));

let queryClient: QueryClient;

function wrapper({ children }: { children: ReactNode }) {
  return createElement(QueryClientProvider, { client: queryClient }, children);
}

beforeEach(() => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.clearAllMocks();
});

describe('IssueDetailPage', () => {
  it('renders status timeline with current status highlighted', () => {
    render(<IssueDetailPage />, { wrapper });

    // Statuses should be visible (enriching/enriched removed)
    expect(screen.getByText('Open')).toBeInTheDocument();
    expect(screen.getByText('Confirmed')).toBeInTheDocument();
    expect(screen.getByText('Approved')).toBeInTheDocument();
    expect(screen.getByText('In Progress')).toBeInTheDocument();
    expect(screen.getByText('Resolved')).toBeInTheDocument();
    expect(screen.getByText('Closed')).toBeInTheDocument();

    // Current status "Open" should have the ring highlight
    const openStep = screen.getByText('Open').closest('.flex.flex-col');
    const openCircle = openStep?.querySelector('.ring-2');
    expect(openCircle).not.toBeNull();
  });

  it('displays AI enrichment fields', () => {
    render(<IssueDetailPage />, { wrapper });

    expect(screen.getByText(/AI summary of the issue/)).toBeInTheDocument();
    expect(screen.getByText(/Fix the bug/)).toBeInTheDocument();
    expect(screen.getByText('criterion 1')).toBeInTheDocument();
    expect(screen.getByText('criterion 2')).toBeInTheDocument();
    expect(screen.getByText(/85%/)).toBeInTheDocument();
  });

  it('shows task progress with correct counts', () => {
    render(<IssueDetailPage />, { wrapper });

    expect(screen.getByText('1/2 completed')).toBeInTheDocument();
    expect(screen.getByText('Task A')).toBeInTheDocument();
    expect(screen.getByText('Task B')).toBeInTheDocument();
  });
});
