import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';
import IssueListPage from '@/app/projects/[slug]/issues/page';

const mockReplace = vi.fn();
let mockSearchParams = new URLSearchParams();

vi.mock('next/navigation', () => ({
  useParams: () => ({ slug: 'test-project' }),
  useRouter: () => ({ replace: mockReplace }),
  useSearchParams: () => mockSearchParams,
}));

vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: { children: ReactNode; href: string }) =>
    createElement('a', { href, ...props }, children),
}));

const mockIssues = [
  {
    id: 1, documentId: 'a', title: 'Login bug', description: 'Cannot login',
    status: 'open', priority: 'high', reportedBy: null,
    createdAt: '2025-01-01', updatedAt: '2025-01-02',
  },
  {
    id: 2, documentId: 'b', title: 'UI glitch', description: 'Button misaligned',
    status: 'resolved', priority: 'low', reportedBy: 'alice',
    createdAt: '2025-01-02', updatedAt: '2025-01-03',
  },
];

vi.mock('@/features/issue/hooks/use-issues', () => ({
  useIssues: () => ({ data: { data: mockIssues }, isLoading: false }),
}));

let queryClient: QueryClient;

function wrapper({ children }: { children: ReactNode }) {
  return createElement(QueryClientProvider, { client: queryClient }, children);
}

beforeEach(() => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  mockSearchParams = new URLSearchParams();
  vi.clearAllMocks();
});

describe('IssueListPage', () => {
  it('renders all issues in the list', () => {
    render(<IssueListPage />, { wrapper });
    expect(screen.getByText('Login bug')).toBeInTheDocument();
    expect(screen.getByText('UI glitch')).toBeInTheDocument();
  });

  it('status filter updates URL and filters displayed issues', () => {
    mockSearchParams = new URLSearchParams('status=open');
    render(<IssueListPage />, { wrapper });

    // Only the open issue should be rendered
    expect(screen.getByText('Login bug')).toBeInTheDocument();
    expect(screen.queryByText('UI glitch')).not.toBeInTheDocument();
  });

  it('search input filters displayed issues by title', () => {
    mockSearchParams = new URLSearchParams('q=Login');
    render(<IssueListPage />, { wrapper });

    expect(screen.getByText('Login bug')).toBeInTheDocument();
    expect(screen.queryByText('UI glitch')).not.toBeInTheDocument();
  });

  it('filter change calls router.replace with correct params', () => {
    render(<IssueListPage />, { wrapper });

    fireEvent.change(screen.getByLabelText('Filter by status'), { target: { value: 'open' } });

    expect(mockReplace).toHaveBeenCalledWith(
      expect.stringContaining('status=open')
    );
  });

  it('shows empty state message when no issues match filters', () => {
    mockSearchParams = new URLSearchParams('status=closed');
    render(<IssueListPage />, { wrapper });

    expect(screen.getByText('No issues match your filters.')).toBeInTheDocument();
    expect(screen.queryByText('Login bug')).not.toBeInTheDocument();
    expect(screen.queryByText('UI glitch')).not.toBeInTheDocument();
  });
});
