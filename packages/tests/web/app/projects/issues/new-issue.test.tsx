import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';
import NewIssuePage from '@/app/projects/[slug]/issues/new/page';

const mockPush = vi.fn();
const mockBack = vi.fn();

vi.mock('next/navigation', () => ({
  useParams: () => ({ slug: 'test-project' }),
  useRouter: () => ({ push: mockPush, back: mockBack }),
}));

const mockMutateAsync = vi.fn();

vi.mock('@/features/issue/hooks/use-issues', () => ({
  useCreateIssue: () => ({
    mutateAsync: mockMutateAsync,
  }),
}));

vi.mock('@/features/project/hooks/use-projects', () => ({
  useProject: () => ({
    data: { data: { id: 1, documentId: 'proj-doc-1', slug: 'test-project', name: 'Test' } },
  }),
}));

vi.mock('@/features/issue/api/issue-api', () => ({
  issueApi: { uploadImage: vi.fn() },
}));

let queryClient: QueryClient;

function wrapper({ children }: { children: ReactNode }) {
  return createElement(QueryClientProvider, { client: queryClient }, children);
}

beforeEach(() => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.clearAllMocks();
});

describe('NewIssuePage', () => {
  it('renders form with title, description, priority, and submit button', () => {
    render(<NewIssuePage />, { wrapper });
    expect(screen.getByLabelText('Title')).toBeInTheDocument();
    expect(screen.getByLabelText('Description')).toBeInTheDocument();
    expect(screen.getByLabelText('Priority')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create Issue' })).toBeInTheDocument();
  });

  it('collects form data and passes correct payload to createIssue', async () => {
    mockMutateAsync.mockResolvedValue({ data: { documentId: 'abc' } });

    render(<NewIssuePage />, { wrapper });

    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Bug report' } });
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Details' } });
    fireEvent.change(screen.getByLabelText('Priority'), { target: { value: 'high' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create Issue' }));

    await waitFor(() => {
      expect(mockMutateAsync).toHaveBeenCalledWith({
        title: 'Bug report',
        description: 'Details',
        priority: 'high',
        project: 'proj-doc-1',
      });
    });
  });

  it('displays error message text visible to user on failure', async () => {
    mockMutateAsync.mockRejectedValue(new Error('Server error'));

    render(<NewIssuePage />, { wrapper });

    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Bug' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create Issue' }));

    await waitFor(() => {
      expect(screen.getByText('Server error')).toBeInTheDocument();
    });
  });

  it('navigates to issues list on successful creation', async () => {
    mockMutateAsync.mockResolvedValue({ data: { documentId: 'abc' } });

    render(<NewIssuePage />, { wrapper });

    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'New issue' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create Issue' }));

    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith('/projects/test-project/issues');
    });
  });
});
