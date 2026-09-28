/**
 * ISS-1279 — the half of the deploy lock that needs no database: what an
 * operator is told when their deploy is refused.
 *
 * The compare-and-set itself is proved against a real Postgres in
 * `tests/integration/deploy-environment-lock-e2e.test.ts`, because a lock is
 * only a lock if two callers arriving together get different answers, and no
 * stub can represent that.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('../db/client.js', () => ({ db: {} }));

const { DEPLOY_LOCK_WAIT_MS, DeployEnvironmentLockedError, deployEnvironmentLockedMessage } =
  await import('./deploy-lock.js');

const holder = {
  projectId: '11111111-1111-4111-8111-111111111111',
  environment: 'live',
  runId: 'run-7',
  subject: 'live deploy (binding b-7), preview deploy (binding b-8)',
  acquiredAt: '2026-09-26T10:00:00.000Z',
  expiresAt: '2026-09-26T10:30:00.000Z',
};

describe('the refusal a held environment gives back', () => {
  const message = deployEnvironmentLockedMessage('live', holder);

  it('opens with the code, so a caller can match on it without parsing prose', () => {
    expect(message.startsWith('DEPLOY_ENVIRONMENT_LOCKED:')).toBe(true);
  });

  it('names the environment it was refused over', () => {
    expect(message).toContain('`live` environment');
  });

  it('names the run holding it', () => {
    expect(message).toContain('run-7');
  });

  it('names what the holder is deploying', () => {
    expect(message).toContain('live deploy (binding b-7), preview deploy (binding b-8)');
  });

  it('names when the hold was taken', () => {
    expect(message).toContain('2026-09-26T10:00:00.000Z');
  });

  it('names when the hold expires', () => {
    expect(message).toContain('2026-09-26T10:30:00.000Z');
  });

  it('names what ends the hold', () => {
    expect(message).toContain('when that deploy ends');
    expect(message).toContain('reclaims it');
  });

  it('says nothing was dispatched and nothing queued, so a caller does not wait for a deploy', () => {
    expect(message).toContain('nothing was dispatched');
    expect(message).toContain('nothing was queued for later');
  });

  it('carries the holder and the environment on the error, not only in the sentence', () => {
    const err = new DeployEnvironmentLockedError('live', holder);
    expect(err.code).toBe('DEPLOY_ENVIRONMENT_LOCKED');
    expect(err.environment).toBe('live');
    expect(err.holder).toBe(holder);
    expect(err.message).toBe(message);
  });
});

describe('the refusal when the holder cannot be read at all', () => {
  const message = deployEnvironmentLockedMessage('preview', null);

  it('says an acquisition is in flight rather than inventing a holder', () => {
    expect(message).toContain('has not committed');
    expect(message).toContain('`preview` environment');
    expect(message).not.toContain('Pipeline run');
  });

  it('states the bound it waited', () => {
    expect(message).toContain(`${DEPLOY_LOCK_WAIT_MS}ms`);
  });

  it('still says nothing was dispatched', () => {
    expect(message).toContain('Nothing was dispatched');
  });
});
