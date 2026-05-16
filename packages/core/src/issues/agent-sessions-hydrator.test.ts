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

  it('reports failed for terminal-only buckets containing a failure', () => {
    expect(deriveAgentStatus([s('completed'), s('failed')])).toBe('failed');
  });

  it('reports completed when only completed sessions exist', () => {
    expect(deriveAgentStatus([s('completed'), s('completed')])).toBe('completed');
  });

  it('ignores unknown statuses (returns null when nothing matches)', () => {
    expect(deriveAgentStatus([s('idle' as never)])).toBe(null);
  });
});
