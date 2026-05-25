import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement, type ReactNode } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { JobDiffPanel } from '@/features/job/components/JobDiffPanel';
import type { PromptEnvelope } from '@/features/job/types-prompt';

vi.mock('@/lib/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/client')>('@/lib/api/client');
  return { ...actual, apiClient: vi.fn() };
});

// react-diff-viewer-continued ships heavy emotion CSS; in jsdom it is fine to
// render the real component, but stubbing keeps the test deterministic and
// lets us assert "diff vs badge" without inspecting library internals.
vi.mock('react-diff-viewer-continued', () => ({
  default: ({ oldValue, newValue }: { oldValue: string; newValue: string }) =>
    createElement(
      'pre',
      { 'data-testid': 'diff-viewer' },
      `OLD:${oldValue}|NEW:${newValue}`,
    ),
}));

const { apiClient } = await import('@/lib/api/client');
const mockedApiClient = apiClient as unknown as ReturnType<typeof vi.fn>;

let qc: QueryClient;
function Wrapper({ children }: { children: ReactNode }) {
  return createElement(QueryClientProvider, { client: qc }, children);
}

function makeEnvelope(overrides: Partial<PromptEnvelope> = {}): PromptEnvelope {
  return {
    jobId: 'job-x',
    systemPrompt: 'system prompt v1',
    systemPromptHash: 'a1b2c3d4e5f6abcdef',
    userPrompt: 'user prompt v1',
    blocks: [],
    estTokens: { input: 500 },
    actualUsage: {
      input: 500,
      output: 80,
      cached: 0,
      cacheCreation: 0,
      cost: 0.01,
      count: 1,
    },
    mcpConfig: null,
    model: 'claude-opus-4-7',
    payloadExtras: {},
    resolvedFlags: {
      state: 'plan',
      skillName: 'forge-plan',
      model: 'claude-opus-4-7',
      allowedTools: null,
      permissionMode: 'default',
      timeoutSeconds: 900,
      sessionGroup: 'planning',
      claudeSessionId: null,
      systemPromptMode: 'append',
    },
    ...overrides,
  };
}

function mockEnvelopes(left: PromptEnvelope, right: PromptEnvelope) {
  mockedApiClient.mockImplementation((endpoint: string) => {
    if (endpoint === `/jobs/${left.jobId}/prompt`) return Promise.resolve(left);
    if (endpoint === `/jobs/${right.jobId}/prompt`) return Promise.resolve(right);
    return Promise.reject(new Error(`unexpected endpoint ${endpoint}`));
  });
}

beforeEach(() => {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  mockedApiClient.mockReset();
});

describe('JobDiffPanel', () => {
  it('short-circuits the system-prompt diff when hashes are equal', async () => {
    const L = makeEnvelope({ jobId: 'job-l' });
    const R = makeEnvelope({ jobId: 'job-r', userPrompt: 'user prompt v2' });
    mockEnvelopes(L, R);

    render(
      createElement(JobDiffPanel, {
        leftJobId: 'job-l',
        rightJobId: 'job-r',
        onClose: vi.fn(),
      }),
      { wrapper: Wrapper },
    );

    await screen.findByTestId('system-prompt-identical');
    expect(screen.getByTestId('system-prompt-identical')).toHaveTextContent(
      'identical (hash a1b2c3d4)',
    );
    // User prompt diff still renders; system prompt diff does NOT.
    expect(screen.getByTestId('user-prompt-diff')).toBeInTheDocument();
    expect(screen.queryByTestId('system-prompt-diff')).toBeNull();
  });

  it('renders both diffs when system hashes differ', async () => {
    const L = makeEnvelope({
      jobId: 'job-l',
      systemPrompt: 'system v1',
      systemPromptHash: 'aaaaaaaa11111111',
    });
    const R = makeEnvelope({
      jobId: 'job-r',
      systemPrompt: 'system v2',
      systemPromptHash: 'bbbbbbbb22222222',
      userPrompt: 'user prompt v2',
    });
    mockEnvelopes(L, R);

    render(
      createElement(JobDiffPanel, {
        leftJobId: 'job-l',
        rightJobId: 'job-r',
        onClose: vi.fn(),
      }),
      { wrapper: Wrapper },
    );

    await screen.findByTestId('system-prompt-diff');
    expect(screen.getByTestId('user-prompt-diff')).toBeInTheDocument();
    expect(screen.queryByTestId('system-prompt-identical')).toBeNull();
  });

  it('formats the signed token delta from actualUsage.input', async () => {
    const L = makeEnvelope({
      jobId: 'job-l',
      actualUsage: { input: 400, output: 0, cached: 0, cacheCreation: 0, cost: 0, count: 1 },
    });
    const R = makeEnvelope({
      jobId: 'job-r',
      actualUsage: { input: 525, output: 0, cached: 0, cacheCreation: 0, cost: 0, count: 1 },
    });
    mockEnvelopes(L, R);

    render(
      createElement(JobDiffPanel, {
        leftJobId: 'job-l',
        rightJobId: 'job-r',
        onClose: vi.fn(),
      }),
      { wrapper: Wrapper },
    );

    const delta = await screen.findByTestId('token-delta');
    expect(delta).toHaveTextContent('+125 input tokens');
  });

  it('renders the delta as n/a when either run has no actualUsage', async () => {
    const L = makeEnvelope({ jobId: 'job-l', actualUsage: null });
    const R = makeEnvelope({ jobId: 'job-r' });
    mockEnvelopes(L, R);

    render(
      createElement(JobDiffPanel, {
        leftJobId: 'job-l',
        rightJobId: 'job-r',
        onClose: vi.fn(),
      }),
      { wrapper: Wrapper },
    );

    const delta = await screen.findByTestId('token-delta');
    await waitFor(() => expect(delta).toHaveTextContent('n/a'));
  });
});
