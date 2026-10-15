// The environments write door holds a written credential to its rules and refuses by name: a row
// with no password, and a second row for one login.

import { beforeEach, describe, expect, it, vi } from 'vitest';

let stored: Record<string, unknown>;
const written = vi.fn();

vi.mock('../db/client.js', () => {
  const tx = {
    select: () => ({
      from: () => ({
        where: () => ({ limit: () => ({ for: async () => [{ environments: stored }] }) }),
      }),
    }),
    update: () => ({ set: (v: unknown) => ({ where: async () => written(v) }) }),
  };
  return { db: { transaction: async (fn: (t: typeof tx) => unknown) => fn(tx) } };
});

const { EnvironmentsError, updateEnvironments } = await import('./environments-service.js');

const QA = { label: 'QA', username: 'qa@example.com', password: 's3cret' };

beforeEach(() => {
  written.mockReset();
  stored = { testCredentials: [QA], limits: null };
});

async function refusal(patch: Record<string, unknown>) {
  const err = await updateEnvironments({
    projectId: 'p1',
    base: structuredClone(stored),
    patch,
  }).catch((e) => e);
  expect(err).toBeInstanceOf(EnvironmentsError);
  return err as InstanceType<typeof EnvironmentsError>;
}

describe('updateEnvironments — the credentials a write names', () => {
  it('refuses a credential with no password, naming the row, and writes nothing', async () => {
    const err = await refusal({
      testCredentials: [QA, { label: 'Admin', username: 'admin@example.com', password: '' }],
    });
    expect(err.code).toBe('ENVIRONMENTS_INVALID');
    expect(err.message).toMatch(/testCredentials\[1\] \('Admin'\) has no password/);
    expect(err.details.conflicts).toEqual([
      expect.objectContaining({ path: 'testCredentials.1.password', rule: 'password-required' }),
    ]);
    expect(written).not.toHaveBeenCalled();
  });

  it('refuses a second row for a login already listed', async () => {
    const err = await refusal({ testCredentials: [QA, { ...QA, label: 'QA again' }] });
    expect(err.details.conflicts).toEqual([
      expect.objectContaining({ path: 'testCredentials.1.username', rule: 'duplicate-login' }),
    ]);
    expect(written).not.toHaveBeenCalled();
  });

  it('stores distinct credentials that each carry a password', async () => {
    await updateEnvironments({
      projectId: 'p1',
      base: structuredClone(stored),
      patch: {
        testCredentials: [QA, { label: 'Admin', username: 'admin@example.com', password: 'x' }],
      },
    });
    expect(written).toHaveBeenCalledTimes(1);
  });

  it('lets a write that does not name the credentials through a row stored before the rule', async () => {
    stored = { testCredentials: [{ ...QA, password: '' }], limits: null };
    await updateEnvironments({
      projectId: 'p1',
      base: structuredClone(stored),
      patch: { limits: 'No mailbox.' },
    });
    expect(written).toHaveBeenCalledTimes(1);
  });
});
