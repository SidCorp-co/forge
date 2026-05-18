import * as React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AgentQueueBadge } from '@/components/issue/agent-queue-badge';
import type { PipelineHealth } from '@/features/issue/types';

const NOW = Date.parse('2026-05-18T08:00:00Z');

function health(overrides: Partial<PipelineHealth> = {}): PipelineHealth {
  return {
    stage: 'approved',
    lastTickAt: new Date(NOW - 30_000).toISOString(),
    ...overrides,
  };
}

describe('AgentQueueBadge — pipelineHealth', () => {
  it('renders amber waiting badge with project_full reason in tooltip', () => {
    const ph = health({
      waitingOn: {
        reason: 'project_full',
        since: new Date(NOW - 2 * 60_000).toISOString(),
        details: { cap: 1, runningIssueIds: ['ISS-12', 'ISS-13'] },
      },
    });
    render(
      <AgentQueueBadge agentStatus="queued" pipelineHealth={ph} now={NOW} />,
    );
    const statusEl = screen.getByRole('status');
    expect(statusEl.getAttribute('title')).toMatch(/project at capacity/i);
    expect(statusEl.getAttribute('title')).toMatch(/ISS-12, ISS-13/);
    expect(statusEl.getAttribute('title')).toMatch(/Queued since 2m ago/);
    expect(statusEl.getAttribute('aria-label')).toMatch(/Agent queued/);
  });

  it('renders blocker ids for waiting_on_dep', () => {
    const ph = health({
      waitingOn: {
        reason: 'waiting_on_dep',
        since: new Date(NOW - 60_000).toISOString(),
        details: { blockerIssueIds: ['ISS-7', 'ISS-9'] },
      },
    });
    render(
      <AgentQueueBadge agentStatus="queued" pipelineHealth={ph} now={NOW} />,
    );
    const statusEl = screen.getByRole('status');
    expect(statusEl.getAttribute('title')).toMatch(/blocker\(s\): ISS-7, ISS-9/);
  });

  it('renders tick-stale warning when lastTickAt > 5 minutes old', () => {
    const ph = health({ lastTickAt: new Date(NOW - 6 * 60_000).toISOString() });
    render(
      <AgentQueueBadge agentStatus="queued" pipelineHealth={ph} now={NOW} />,
    );
    const warning = screen.getByRole('img');
    expect(warning.getAttribute('aria-label')).toMatch(/tick stale/i);
  });

  it('does not render tick-stale warning when tick is fresh', () => {
    const ph = health({ lastTickAt: new Date(NOW - 30_000).toISOString() });
    render(
      <AgentQueueBadge agentStatus="queued" pipelineHealth={ph} now={NOW} />,
    );
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('falls back to plain queued visual when no pipelineHealth is provided', () => {
    render(<AgentQueueBadge agentStatus="queued" />);
    expect(screen.getByLabelText(/Agent queued: queued/)).toBeInTheDocument();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('does not render waiting visual when status is running', () => {
    const ph = health({
      waitingOn: {
        reason: 'project_full',
        since: new Date(NOW - 60_000).toISOString(),
        details: { cap: 1 },
      },
    });
    render(
      <AgentQueueBadge agentStatus="running" pipelineHealth={ph} now={NOW} />,
    );
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.getByLabelText(/Agent running/)).toBeInTheDocument();
  });

  it('aria-label includes skill name and waiting state', () => {
    const ph = health({
      waitingOn: {
        reason: 'manual_hold',
        since: new Date(NOW - 60_000).toISOString(),
        details: {},
      },
    });
    render(
      <AgentQueueBadge
        session={{ status: 'queued', metadata: { skill: 'forge-code' } }}
        pipelineHealth={ph}
        now={NOW}
      />,
    );
    const statusEl = screen.getByRole('status');
    expect(statusEl.getAttribute('aria-label')).toMatch(/Manual hold/);
    expect(statusEl.getAttribute('aria-label')).toMatch(/forge-code/);
  });
});
