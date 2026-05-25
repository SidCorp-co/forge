import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement, type ReactNode } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HistoryTab } from '@/features/job/components/inspector-tabs/HistoryTab';
import type { JobHistoryRow } from '@/features/job/types';

vi.mock('@/lib/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/client')>('@/lib/api/client');
  return { ...actual, apiClient: vi.fn() };
});

// JobDiffPanel pulls in `react-diff-viewer-continued` which is heavy in jsdom.
// HistoryTab only cares that the modal *renders* on click — stub the panel.
vi.mock('@/features/job/components/JobDiffPanel', () => ({
  JobDiffPanel: ({ leftJobId, rightJobId }: { leftJobId: string; rightJobId: string }) =>
    createElement(
      'div',
      { 'data-testid': 'job-diff-panel' },
      `${leftJobId} vs ${rightJobId}`,
    ),
}));

const { apiClient } = await import('@/lib/api/client');
const mockedApiClient = apiClient as unknown as ReturnType<typeof vi.fn>;

let qc: QueryClient;
function Wrapper({ children }: { children: ReactNode }) {
  return createElement(QueryClientProvider, { client: qc }, children);
}

const newer: JobHistoryRow = {
  jobId: 'job-newer',
  status: 'succeeded',
  model: 'claude-opus-4-7',
  startedAt: '2026-05-25T11:00:00.000Z',
  finishedAt: '2026-05-25T11:00:08.000Z',
  estTokens: 220,
  tokens: 300,
  cost: 0.005,
};
const older: JobHistoryRow = {
  jobId: 'job-older',
  status: 'succeeded',
  model: 'claude-sonnet-4-6',
  startedAt: '2026-05-25T10:00:00.000Z',
  finishedAt: '2026-05-25T10:00:05.000Z',
  estTokens: 100,
  tokens: 200,
  cost: 0.0015,
};
const queued: JobHistoryRow = {
  jobId: 'job-queued',
  status: 'queued',
  model: null,
  startedAt: null,
  finishedAt: null,
  estTokens: 75,
  tokens: 0,
  cost: 0,
};

beforeEach(() => {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  mockedApiClient.mockReset();
});

describe('HistoryTab', () => {
  it('renders the empty state when issueId or step is missing', () => {
    render(
      createElement(HistoryTab, { jobId: 'job-1', issueId: null, step: 'plan' }),
      { wrapper: Wrapper },
    );
    expect(screen.getByText('No per-issue history')).toBeInTheDocument();
  });

  it('renders rows with status / model / tokens / cost / duration', async () => {
    mockedApiClient.mockResolvedValueOnce([queued, newer, older]);

    render(
      createElement(HistoryTab, { jobId: 'job-newer', issueId: 'iss-1', step: 'plan' }),
      { wrapper: Wrapper },
    );

    await screen.findByText('claude-opus-4-7');
    expect(screen.getByText('claude-sonnet-4-6')).toBeInTheDocument();
    expect(screen.getByText('300')).toBeInTheDocument();
    expect(screen.getByText('200')).toBeInTheDocument();
    // queued job: tokens fallback to ~estTokens
    expect(screen.getByText('~75')).toBeInTheDocument();
    expect(screen.getByText('$0.0050')).toBeInTheDocument();
    expect(screen.getByText('$0.0015')).toBeInTheDocument();
    expect(screen.getByText('8s')).toBeInTheDocument();
    expect(screen.getByText('5s')).toBeInTheDocument();
  });

  it('disables Compare button until exactly 2 rows are selected', async () => {
    mockedApiClient.mockResolvedValueOnce([newer, older, queued]);

    render(
      createElement(HistoryTab, { jobId: 'job-newer', issueId: 'iss-1', step: 'plan' }),
      { wrapper: Wrapper },
    );

    const button = (await screen.findByRole('button', { name: /Compare selected/ })) as HTMLButtonElement;
    expect(button).toBeDisabled();

    const [cb1, cb2, cb3] = screen.getAllByRole('checkbox') as HTMLInputElement[];
    fireEvent.click(cb1);
    expect(button).toBeDisabled();
    fireEvent.click(cb2);
    expect(button).not.toBeDisabled();
    fireEvent.click(cb3);
    expect(button).toBeDisabled();
  });

  it('opens JobDiffPanel with older→left, newer→right when Compare is clicked', async () => {
    mockedApiClient.mockResolvedValueOnce([newer, older]);

    render(
      createElement(HistoryTab, { jobId: 'job-newer', issueId: 'iss-1', step: 'plan' }),
      { wrapper: Wrapper },
    );

    await screen.findByText('claude-opus-4-7');
    const checkboxes = screen.getAllByRole('checkbox') as HTMLInputElement[];
    fireEvent.click(checkboxes[0]); // newer
    fireEvent.click(checkboxes[1]); // older
    fireEvent.click(screen.getByRole('button', { name: /Compare selected/ }));

    await waitFor(() => {
      expect(screen.getByTestId('job-diff-panel')).toHaveTextContent(
        'job-older vs job-newer',
      );
    });
  });
});
