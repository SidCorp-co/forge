import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';
import BoardPage from '@/app/projects/[slug]/board/page';

vi.mock('next/navigation', () => ({
  useParams: () => ({ slug: 'test-project' }),
}));

vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: { children: ReactNode; href: string }) =>
    createElement('a', { href, ...props }, children),
}));

const mockTasks = [
  { id: 1, title: 'Task Backlog', status: 'backlog', priority: 'low', assignee: null, isAgentTask: true, agentStatus: 'idle' },
  { id: 2, title: 'Task Todo', status: 'todo', priority: 'medium', assignee: 'alice', isAgentTask: false, agentStatus: null },
  { id: 3, title: 'Task Progress', status: 'in_progress', priority: 'high', assignee: 'bob', isAgentTask: true, agentStatus: 'running' },
  { id: 4, title: 'Task Review', status: 'in_review', priority: 'medium', assignee: 'alice', isAgentTask: true, agentStatus: 'completed' },
  { id: 5, title: 'Task Done', status: 'done', priority: 'low', assignee: 'bob', isAgentTask: true, agentStatus: 'failed' },
];

vi.mock('@/features/task/hooks/use-tasks', () => ({
  useTasks: () => ({ data: { data: mockTasks }, isLoading: false }),
}));

let queryClient: QueryClient;

function wrapper({ children }: { children: ReactNode }) {
  return createElement(QueryClientProvider, { client: queryClient }, children);
}

beforeEach(() => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

describe('BoardPage', () => {
  it('renders all 5 column headings', () => {
    render(<BoardPage />, { wrapper });
    expect(screen.getByText('Backlog')).toBeInTheDocument();
    expect(screen.getByText('Todo')).toBeInTheDocument();
    expect(screen.getByText('In Progress')).toBeInTheDocument();
    expect(screen.getByText('In Review')).toBeInTheDocument();
    expect(screen.getByText('Done')).toBeInTheDocument();
  });

  it('each task appears inside its correct column', () => {
    render(<BoardPage />, { wrapper });

    // Verify each task text is inside a column with the correct heading
    const taskBacklog = screen.getByText('Task Backlog');
    const backlogColumn = screen.getByText('Backlog').closest('[class*="rounded-lg"]');
    expect(backlogColumn).toContainElement(taskBacklog);

    const taskTodo = screen.getByText('Task Todo');
    const todoColumn = screen.getByText('Todo').closest('[class*="rounded-lg"]');
    expect(todoColumn).toContainElement(taskTodo);

    const taskProgress = screen.getByText('Task Progress');
    const progressColumn = screen.getByText('In Progress').closest('[class*="rounded-lg"]');
    expect(progressColumn).toContainElement(taskProgress);

    const taskReview = screen.getByText('Task Review');
    const reviewColumn = screen.getByText('In Review').closest('[class*="rounded-lg"]');
    expect(reviewColumn).toContainElement(taskReview);

    const taskDone = screen.getByText('Task Done');
    const doneColumn = screen.getByText('Done').closest('[class*="rounded-lg"]');
    expect(doneColumn).toContainElement(taskDone);
  });

  it('renders correct agent status indicators per task', () => {
    const { container } = render(<BoardPage />, { wrapper });

    // idle (Task Backlog only, Task Todo is not agent task) -> gray dots
    const grayDots = container.querySelectorAll('.bg-gray-300');
    expect(grayDots).toHaveLength(1);

    // running (Task Progress) -> animate-ping
    const pingDots = container.querySelectorAll('.animate-ping');
    expect(pingDots).toHaveLength(1);

    // completed (Task Review) -> green check
    const greenChecks = container.querySelectorAll('.text-green-500');
    expect(greenChecks).toHaveLength(1);

    // failed (Task Done) -> red x
    const redXs = container.querySelectorAll('.text-red-500');
    expect(redXs).toHaveLength(1);
  });
});
