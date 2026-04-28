import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';
import { IssueDetailModal } from '@/components/issue/issue-detail-modal';

const mockUpdateMutate = vi.fn();
const mockEnrichMutate = vi.fn();

const baseIssue = {
  id: 1,
  documentId: 'abc-123',
  title: 'Test Issue',
  description: 'A test',
  status: 'open' as string,
  priority: 'high' as const,
  category: 'bug',
  reportedBy: null,
  aiSummary: null as string | null,
  aiSuggestedSolution: null as string | null,
  aiAcceptanceCriteria: null as string[] | null,
  aiConfidence: null as number | null,
  isAgentTask: false,
  attachments: [],
  tasks: [] as { id: number; documentId: string; title: string; status: string }[],
  comments: [] as { id: number }[],
  createdAt: '2025-01-01',
  updatedAt: '2025-01-01',
  agentStatus: null as string | null,
  agentLog: null as unknown[] | null,
  project: null as { id: number; documentId: string; slug: string; name: string } | null,
};

let issueOverrides: Partial<typeof baseIssue> = {};

vi.mock('@/features/issue/hooks/use-issues', () => ({
  useIssue: () => ({
    data: { data: { ...baseIssue, ...issueOverrides } },
    isLoading: false,
  }),
  useUpdateIssue: () => ({ mutate: mockUpdateMutate }),
  useEnrichIssue: () => ({ mutate: mockEnrichMutate }),
}));

vi.mock('@/features/comment/hooks/use-comments', () => ({
  useComments: () => ({ data: { data: [] } }),
  useCreateComment: () => ({ mutate: vi.fn() }),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useParams: () => ({ slug: 'test-project' }),
}));

vi.mock('@/hooks/agent-stream-context', () => ({
  useAgentStreamContext: () => ({
    desktopConnected: false,
    requestBuildPrompt: vi.fn(),
    isBuildingPrompt: false,
  }),
}));

let queryClient: QueryClient;

function wrapper({ children }: { children: ReactNode }) {
  return createElement(QueryClientProvider, { client: queryClient }, children);
}

beforeEach(() => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.clearAllMocks();
  issueOverrides = {};
});

describe('IssueDetailModal – enrichment scenarios', () => {
  it('renders Enrich button when status is open', () => {
    issueOverrides = { status: 'open' as any };
    render(<IssueDetailModal issueId="abc-123" onClose={vi.fn()} />, { wrapper });

    expect(screen.getByRole('button', { name: 'Enrich' })).toBeInTheDocument();
  });

  it('Enrich button calls enrich API with documentId', () => {
    issueOverrides = { status: 'open' as any };
    render(<IssueDetailModal issueId="abc-123" onClose={vi.fn()} />, { wrapper });

    fireEvent.click(screen.getByRole('button', { name: 'Enrich' }));

    expect(mockEnrichMutate).toHaveBeenCalledWith('abc-123');
  });

  it('hides Enrich button when status is not open', () => {
    issueOverrides = { status: 'confirmed' as any };
    render(<IssueDetailModal issueId="abc-123" onClose={vi.fn()} />, { wrapper });

    expect(screen.queryByRole('button', { name: 'Enrich' })).not.toBeInTheDocument();
  });

  it('displays AI enrichment results when aiSummary exists', () => {
    issueOverrides = {
      status: 'open' as any,
      aiSummary: 'AI summary of the issue',
      aiSuggestedSolution: 'Fix the bug',
      aiAcceptanceCriteria: ['criterion 1', 'criterion 2'],
      aiConfidence: 0.85,
    };
    render(<IssueDetailModal issueId="abc-123" onClose={vi.fn()} />, { wrapper });

    expect(screen.getByText(/AI summary of the issue/)).toBeInTheDocument();
    expect(screen.getByText(/Fix the bug/)).toBeInTheDocument();
    expect(screen.getByText('criterion 1')).toBeInTheDocument();
    expect(screen.getByText('criterion 2')).toBeInTheDocument();
    expect(screen.getByText(/85%/)).toBeInTheDocument();
  });

  it('displays AI analysis without Confirm button (enriched status removed)', () => {
    issueOverrides = {
      status: 'open' as any,
      aiSummary: 'AI summary of the issue',
    };
    render(<IssueDetailModal issueId="abc-123" onClose={vi.fn()} />, { wrapper });

    expect(screen.getByText(/AI summary of the issue/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Confirm' })).not.toBeInTheDocument();
  });
});
