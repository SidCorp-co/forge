import { describe, expect, it, vi } from 'vitest';

vi.mock('../config/env.js', () => ({
  env: {
    JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef',
    DEVICE_TOKEN_PEPPER: 'test-pepper-32-chars-long-abcdefghij',
    DATABASE_URL: 'postgres://test',
    NODE_ENV: 'test',
  },
}));

vi.mock('../db/client.js', () => ({
  db: { select: vi.fn() },
}));

const { deriveAgentStatus } = await import('./agent-sessions-hydrator.js');
type HydratedAgentSession = import('./agent-sessions-hydrator.js').HydratedAgentSession;

function s(
  status: HydratedAgentSession['status'],
  updatedAt = new Date(),
): HydratedAgentSession {
  return {
    id: crypto.randomUUID(),
    status,
    metadata: { issueId: 'fake' },
    createdAt: new Date(updatedAt.getTime() - 1000),
    updatedAt,
    title: null,
    deviceId: null,
    startedAt: null,
    lastHeartbeatAt: null,
    pipelineRunId: null,
    claudeSessionId: null,
    deviceName: null,
  };
}

describe('deriveAgentStatus', () => {
  it('returns null for empty input', () => {
    expect(deriveAgentStatus([])).toBe(null);
  });

  it('prefers running over any other state', () => {
    expect(
      deriveAgentStatus([s('completed'), s('queued'), s('running'), s('failed')]),
    ).toBe('running');
  });

  it('falls back to queued when no running session exists', () => {
    expect(deriveAgentStatus([s('completed'), s('queued'), s('failed')])).toBe('queued');
  });

  // Callers pass sessions ordered updated_at DESC (most-recent first).
  it('reports the most-recent terminal status: newer completed beats older failed', () => {
    const newer = new Date();
    const older = new Date(newer.getTime() - 60_000);
    // A superseded/cancelled run's stale failure must NOT mask a newer success
    // (the `tested` issue showing a red "failed" badge bug).
    expect(deriveAgentStatus([s('completed', newer), s('failed', older)])).toBe('completed');
  });

  it('reports the most-recent terminal status: newer failed beats older completed', () => {
    const newer = new Date();
    const older = new Date(newer.getTime() - 60_000);
    expect(deriveAgentStatus([s('failed', newer), s('completed', older)])).toBe('failed');
  });

  it('treats completed_via_recovery as completed', () => {
    expect(deriveAgentStatus([s('completed_via_recovery' as never)])).toBe('completed');
  });

  it('reports completed when only completed sessions exist', () => {
    expect(deriveAgentStatus([s('completed'), s('completed')])).toBe('completed');
  });

  it('ignores unknown statuses (returns null when nothing matches)', () => {
    expect(deriveAgentStatus([s('idle' as never)])).toBe(null);
  });
});
