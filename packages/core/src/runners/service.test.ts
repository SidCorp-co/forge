// cm:guard the collision must be recognised by CONSTRAINT NAME — a bare "it was a 23505" would answer any future unique index on `runners` with a binding message that names the wrong column, which is the mislabelling `projects/service.ts` already learned to refuse.

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../config/env.js', () => ({
  env: {
    JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef',
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://localhost/stub',
  },
}));

const insertImpl = vi.fn();
const selectImpl = vi.fn();

vi.mock('../db/client.js', () => ({
  db: {
    insert: (...a: unknown[]) => insertImpl(...a),
    select: (...a: unknown[]) => selectImpl(...a),
  },
}));

const { insertRunner, RunnerAlreadyBoundError } = await import('./service.js');

const PROJECT_ID = '33333333-3333-4333-8333-333333333333';
const DEVICE_ID = '66666666-6666-4666-8666-666666666666';
const COLLIDED_ID = '77777777-7777-4777-8777-777777777777';

const INPUT = {
  projectId: PROJECT_ID,
  type: 'claude-code' as const,
  deviceId: DEVICE_ID,
  name: 'forge-vm',
  labels: [],
  capabilities: {},
  config: {},
};

/** What postgres-js raises through Drizzle's wrapper: SQLSTATE on `cause`. */
function uniqueViolation(constraint: string) {
  return Object.assign(new Error('duplicate key value violates unique constraint'), {
    cause: { code: '23505', constraint_name: constraint },
  });
}

function mockCollided(row: { id: string; name: string; status: string } | null) {
  selectImpl.mockImplementationOnce(() => ({
    from: () => ({ where: () => ({ limit: () => Promise.resolve(row ? [row] : []) }) }),
  }));
}

beforeEach(() => {
  insertImpl.mockReset();
  selectImpl.mockReset();
});

describe('insertRunner when the device already binds this project', () => {
  beforeEach(() => {
    insertImpl.mockImplementationOnce(() => ({
      values: () => ({
        returning: () => Promise.reject(uniqueViolation('runners_project_device_type_uq')),
      }),
    }));
  });

  it('refuses by name, carrying the runner it collided with', async () => {
    mockCollided({ id: COLLIDED_ID, name: 'forge-vm', status: 'disabled' });

    const err = await insertRunner(INPUT).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(RunnerAlreadyBoundError);
    expect((err as InstanceType<typeof RunnerAlreadyBoundError>).collided?.id).toBe(COLLIDED_ID);
    expect((err as Error).message).toContain(COLLIDED_ID);
    expect((err as Error).message).toContain('forge-vm');
    expect((err as Error).message).toContain('disabled');
  });

  it('sends a retired collider to restore rather than to a second registration', async () => {
    mockCollided({ id: COLLIDED_ID, name: 'forge-vm', status: 'disabled' });

    const err = (await insertRunner(INPUT).catch((e: unknown) => e)) as Error;

    expect(err.message).toMatch(/restore it/i);
    expect(err.message).not.toMatch(/re-register/i);
  });

  it('sends a live collider to unassign, which is the only way its binding frees up', async () => {
    mockCollided({ id: COLLIDED_ID, name: 'forge-vm', status: 'online' });

    const err = (await insertRunner(INPUT).catch((e: unknown) => e)) as Error;

    expect(err.message).toMatch(/unassign/i);
  });

  // cm:guard a vanished collider means the binding is free — refusing here with a runner nobody can read would send the caller after a row that no longer exists, and the id in that message would be invented (ISS-990).
  it('retries the insert when the colliding row has since gone, rather than naming a runner nobody can read', async () => {
    mockCollided(null);
    insertImpl.mockImplementationOnce(() => ({
      values: () => ({ returning: () => Promise.resolve([{ id: 'r2', status: 'offline' }]) }),
    }));

    await expect(insertRunner(INPUT)).resolves.toMatchObject({ id: 'r2' });
  });

  it('refuses without inventing a runner when the retry collides all over again', async () => {
    mockCollided(null);
    insertImpl.mockImplementationOnce(() => ({
      values: () => ({
        returning: () => Promise.reject(uniqueViolation('runners_project_device_type_uq')),
      }),
    }));

    const err = await insertRunner(INPUT).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(RunnerAlreadyBoundError);
    expect((err as InstanceType<typeof RunnerAlreadyBoundError>).collided).toBeNull();
    expect((err as Error).message).not.toMatch(/unread/i);
  });
});

describe('insertRunner on every other failure', () => {
  it('rethrows a unique violation from a different index rather than mislabelling it', async () => {
    const other = uniqueViolation('runners_some_other_uq');
    insertImpl.mockImplementationOnce(() => ({
      values: () => ({ returning: () => Promise.reject(other) }),
    }));

    const err = await insertRunner(INPUT).catch((e: unknown) => e);

    expect(err).toBe(other);
    expect(err).not.toBeInstanceOf(RunnerAlreadyBoundError);
  });

  it('rethrows a non-unique error untouched', async () => {
    const boom = new Error('connection terminated');
    insertImpl.mockImplementationOnce(() => ({
      values: () => ({ returning: () => Promise.reject(boom) }),
    }));

    await expect(insertRunner(INPUT)).rejects.toBe(boom);
  });

  it('returns the row when the insert succeeds', async () => {
    insertImpl.mockImplementationOnce(() => ({
      values: () => ({ returning: () => Promise.resolve([{ id: 'r1', status: 'offline' }]) }),
    }));

    await expect(insertRunner(INPUT)).resolves.toMatchObject({ id: 'r1' });
  });
});
