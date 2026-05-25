import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';
import { ApiError } from '@/lib/api/client';
import { PromptInspectorDrawer } from '@/features/job/components/PromptInspectorDrawer';
import type { PromptEnvelope } from '@/features/job/types-prompt';

vi.mock('@/lib/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/client')>(
    '@/lib/api/client',
  );
  return {
    ...actual,
    apiClient: vi.fn(),
  };
});

const { apiClient } = await import('@/lib/api/client');
const mockedApiClient = apiClient as unknown as ReturnType<typeof vi.fn>;

let queryClient: QueryClient;

function Wrapper({ children }: { children: ReactNode }) {
  return createElement(QueryClientProvider, { client: queryClient }, children);
}

function makeEnvelope(overrides: Partial<PromptEnvelope> = {}): PromptEnvelope {
  return {
    jobId: 'job-1',
    systemPrompt: 'system prompt content',
    userPrompt: 'user prompt content',
    blocks: [
      { id: 'system-base', kind: 'system', chars: 1200, estTokens: 300 },
      { id: 'user-issue', kind: 'user', chars: 800, estTokens: 200 },
    ],
    estTokens: { input: 500 },
    actualUsage: {
      input: 500,
      output: 80,
      cached: 10,
      cacheCreation: 2,
      cost: 0.0123,
      count: 1,
    },
    mcpConfig: null,
    model: 'claude-opus-4-7',
    payloadExtras: {},
    resolvedFlags: {
      state: 'code',
      skillName: 'forge-code',
      model: 'claude-opus-4-7',
      allowedTools: null,
      permissionMode: 'default',
      timeoutSeconds: 900,
      sessionGroup: 'implementation',
      claudeSessionId: null,
      systemPromptMode: 'append',
    },
    ...overrides,
  };
}

beforeEach(() => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  mockedApiClient.mockReset();
});

describe('PromptInspectorDrawer', () => {
  it('renders prompt + block breakdown on the happy path', async () => {
    mockedApiClient.mockImplementation((endpoint: string) => {
      if (endpoint === '/jobs/job-1/prompt') return Promise.resolve(makeEnvelope());
      if (endpoint === '/jobs/job-1') {
        return Promise.resolve({
          id: 'job-1',
          status: 'done',
          agentSessionId: 'session-1',
          queuedAt: '2026-05-25T10:00:00.000Z',
          dispatchedAt: '2026-05-25T10:00:05.000Z',
          finishedAt: '2026-05-25T10:00:30.000Z',
        });
      }
      return Promise.reject(new Error(`unexpected endpoint ${endpoint}`));
    });

    render(
      createElement(PromptInspectorDrawer, { jobId: 'job-1', onClose: vi.fn() }),
      { wrapper: Wrapper },
    );

    await waitFor(() => {
      expect(screen.getByText('system prompt content')).toBeInTheDocument();
    });
    expect(screen.getByText('user prompt content')).toBeInTheDocument();
    expect(screen.getByText('system-base')).toBeInTheDocument();
    expect(screen.getByText('user-issue')).toBeInTheDocument();
    // 60.0% (300/500) and 40.0% (200/500) — also a 100.0% total row.
    expect(screen.getByText('60.0%')).toBeInTheDocument();
    expect(screen.getByText('40.0%')).toBeInTheDocument();
    expect(screen.getByText('100.0%')).toBeInTheDocument();

    // Switch to Usage tab and check cache-hit pill.
    fireEvent.click(screen.getByRole('tab', { name: 'Usage' }));
    const pill = await screen.findByTestId('cache-pill');
    expect(pill).toHaveTextContent('cache hit');
  });

  it('renders cache-cold pill when cached <= cacheCreation', async () => {
    const env = makeEnvelope({
      actualUsage: {
        input: 100,
        output: 20,
        cached: 1,
        cacheCreation: 5,
        cost: 0.001,
        count: 1,
      },
    });
    mockedApiClient.mockImplementation((endpoint: string) => {
      if (endpoint === '/jobs/job-1/prompt') return Promise.resolve(env);
      if (endpoint === '/jobs/job-1')
        return Promise.resolve({ id: 'job-1', status: 'done', agentSessionId: null });
      return Promise.reject(new Error(`unexpected endpoint ${endpoint}`));
    });

    render(
      createElement(PromptInspectorDrawer, { jobId: 'job-1', onClose: vi.fn() }),
      { wrapper: Wrapper },
    );

    await screen.findByText('system prompt content');
    fireEvent.click(screen.getByRole('tab', { name: 'Usage' }));
    const pill = await screen.findByTestId('cache-pill');
    expect(pill).toHaveTextContent('cache cold');
  });

  it('shows the no-snapshot empty state on 404', async () => {
    mockedApiClient.mockImplementation((endpoint: string) => {
      if (endpoint === '/jobs/job-1/prompt') {
        return Promise.reject(
          new ApiError(404, 'prompt snapshot not stored (pre-v0.1.35 job)'),
        );
      }
      return Promise.resolve({ id: 'job-1', status: 'done', agentSessionId: null });
    });

    render(
      createElement(PromptInspectorDrawer, { jobId: 'job-1', onClose: vi.fn() }),
      { wrapper: Wrapper },
    );

    await screen.findByText('No prompt snapshot stored');
    expect(
      screen.getByText(
        'This job ran before v0.1.35 (W2.1.1 snapshot path). Re-run the pipeline step to capture a snapshot.',
      ),
    ).toBeInTheDocument();
  });

  it('shows the archived empty state with archive path on 410', async () => {
    mockedApiClient.mockImplementation((endpoint: string) => {
      if (endpoint === '/jobs/job-1/prompt') {
        return Promise.reject(
          new ApiError(
            410,
            'Gone',
            undefined,
            undefined,
            { archived: true, path: 's3://forge-archive/jobs/job-1' },
          ),
        );
      }
      return Promise.resolve({ id: 'job-1', status: 'done', agentSessionId: null });
    });

    render(
      createElement(PromptInspectorDrawer, { jobId: 'job-1', onClose: vi.fn() }),
      { wrapper: Wrapper },
    );

    await screen.findByText('Snapshot archived');
    const path = await screen.findByTestId('empty-state-path');
    expect(path).toHaveTextContent('s3://forge-archive/jobs/job-1');
  });

  it('shows the no-agent-session empty state on Response tab', async () => {
    mockedApiClient.mockImplementation((endpoint: string) => {
      if (endpoint === '/jobs/job-1/prompt') return Promise.resolve(makeEnvelope());
      if (endpoint === '/jobs/job-1') {
        return Promise.resolve({
          id: 'job-1',
          status: 'done',
          agentSessionId: null,
          queuedAt: '2026-05-25T10:00:00.000Z',
        });
      }
      return Promise.reject(new Error(`unexpected endpoint ${endpoint}`));
    });

    render(
      createElement(PromptInspectorDrawer, { jobId: 'job-1', onClose: vi.fn() }),
      { wrapper: Wrapper },
    );

    await screen.findByText('system prompt content');
    fireEvent.click(screen.getByRole('tab', { name: 'Response' }));
    await screen.findByText('No agent session attached');
  });
});
