/**
 * Agent Access Token service unit tests (ISS-932).
 *
 * The rules that are not visible in the types: an agent joins its org as a
 * plain `member` and never an admin, a project outside the org is refused, the
 * handle shape is enforced before anything is written, and retiring an agent
 * removes its authority without deleting the row every activity record points
 * at.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../config/env.js', () => ({
  env: { NODE_ENV: 'test', PAT_PEPPER: 'p'.repeat(32) },
}));

const mintPat = vi.fn(async (_input: unknown) => ({
  plaintext: 'forge_pat_dev_deadbeef',
  row: { id: 'pat-1' },
}));
vi.mock('../auth/pat.js', () => ({ mintPat: (i: unknown) => mintPat(i) }));

const selectLimit = vi.fn();
const inserted: { table: string; values: unknown }[] = [];
const deleted: string[] = [];
const updated: { values: unknown }[] = [];

const tx = {
  insert: (table: unknown) => ({
    values: (values: unknown) => {
      inserted.push({ table: tableName(table), values });
      const done = Promise.resolve([{ id: 'agent-1', createdAt: new Date(0) }]);
      return Object.assign(done, { returning: () => done });
    },
  }),
  delete: (table: unknown) => ({ where: async () => deleted.push(tableName(table)) }),
  update: (_t: unknown) => ({
    set: (values: unknown) => ({
      where: async () => updated.push({ values }),
    }),
  }),
};

function tableName(t: unknown): string {
  const sym = Object.getOwnPropertySymbols(t as object).find((s) => String(s).includes('Name'));
  return sym ? String((t as Record<symbol, unknown>)[sym]) : 'unknown';
}

vi.mock('../db/client.js', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({ limit: () => selectLimit() }),
        innerJoin: () => ({ where: () => ({ limit: () => selectLimit() }) }),
      }),
    }),
    transaction: async (fn: (t: unknown) => Promise<unknown>) => fn(tx),
  },
}));

const { createAgentAccount, revokeAgentAccount } = await import('./agent-accounts.js');

function insertedValues(i: number): unknown {
  const row = inserted.at(i);
  if (!row) throw new Error(`no insert at index ${i}`);
  return row.values;
}

const ORG = '00000000-0000-4000-8000-00000000e000';
const PROJECT = '00000000-0000-4000-8000-00000000f000';

beforeEach(() => {
  vi.clearAllMocks();
  inserted.length = 0;
  deleted.length = 0;
  updated.length = 0;
});

const args = { orgId: ORG, projectId: PROJECT, handle: 'master' };

describe('createAgentAccount', () => {
  it.each([['UPPER'], ['a'], ['-lead'], ['trail-'], ['has space'], ['sym$bol']])(
    'refuses the handle %s before touching the database',
    async (handle) => {
      const err = await createAgentAccount({ ...args, handle }).catch((e) => e);
      expect((err.cause as { code: string }).code).toBe('INVALID_AGENT_HANDLE');
      expect(selectLimit).not.toHaveBeenCalled();
      expect(mintPat).not.toHaveBeenCalled();
    },
  );

  // cm:guard the project's org is compared against the ROUTE's org, not merely looked up. Without it an org admin mints an agent into any project id they can guess, and the agent — a real member from that moment — carries the authority out of the org that approved it.
  it('refuses a project that belongs to another org, and mints nothing', async () => {
    selectLimit.mockResolvedValueOnce([{ id: PROJECT, orgId: 'some-other-org' }]);
    const err = await createAgentAccount(args).catch((e) => e);
    expect((err as { status: number }).status).toBe(404);
    expect(mintPat).not.toHaveBeenCalled();
  });

  it('refuses a project that does not exist', async () => {
    selectLimit.mockResolvedValueOnce([]);
    const err = await createAgentAccount(args).catch((e) => e);
    expect((err as { status: number }).status).toBe(404);
  });

  it('creates the user, both memberships and one bound token', async () => {
    selectLimit.mockResolvedValueOnce([{ id: PROJECT, orgId: ORG }]);
    const out = await createAgentAccount(args);

    expect(out.plaintext).toBe('forge_pat_dev_deadbeef');
    expect(out.agent.projectId).toBe(PROJECT);
    expect(inserted.map((i) => i.table)).toEqual([
      'users',
      'organization_members',
      'project_members',
    ]);
    expect(mintPat).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'agent:master', boundProjectId: PROJECT }),
    );
  });

  it('marks the row an agent, with a password-less reserved-invalid address', async () => {
    selectLimit.mockResolvedValueOnce([{ id: PROJECT, orgId: ORG }]);
    await createAgentAccount(args);
    const user = insertedValues(0) as {
      kind: string;
      email: string;
      passwordHash: null;
      emailVerifiedAt: Date;
    };
    expect(user.kind).toBe('agent');
    expect(user.passwordHash).toBeNull();
    expect(user.email).toMatch(/^master\.[0-9a-f]{12}@agents\.forge\.invalid$/);
    expect(user.emailVerifiedAt).toBeInstanceOf(Date);
  });

  // cm:guard org `member`, never `admin`. An agent holding org admin could reach `POST /api/orgs/:orgId/agents` and mint further agents with any project it liked — a scoped credential minting unscoped ones, which is the same hole `/api/pat`'s absence from `PAT_ALLOWED_PREFIXES` closes from the other side.
  it('joins the org as a plain member', async () => {
    selectLimit.mockResolvedValueOnce([{ id: PROJECT, orgId: ORG }]);
    await createAgentAccount(args);
    expect((insertedValues(1) as { role: string }).role).toBe('member');
  });

  it('takes the project role it was given', async () => {
    selectLimit.mockResolvedValueOnce([{ id: PROJECT, orgId: ORG }]);
    await createAgentAccount({ ...args, projectRole: 'admin' });
    expect((insertedValues(2) as { role: string }).role).toBe('admin');
  });
});

describe('revokeAgentAccount', () => {
  it('answers false for an id that is not an agent of this org, writing nothing', async () => {
    selectLimit.mockResolvedValueOnce([]);
    expect(await revokeAgentAccount(ORG, 'not-an-agent')).toBe(false);
    expect(deleted).toEqual([]);
    expect(updated).toEqual([]);
  });

  // cm:guard the `users` row SURVIVES, and this is the assertion that keeps it. `activity_log.actor_id`, `kernel_transitions.actor_id` and `jobs.created_by` all point at it, so deleting it either cascades away the record of what the agent did or fails on a restrict — and a real principal whose history vanishes on retirement answers "who made this write" with nothing, which is the whole thing the AAT exists to fix.
  it('revokes the tokens and both memberships, and never deletes the user row', async () => {
    selectLimit.mockResolvedValueOnce([{ id: 'agent-1' }]);
    expect(await revokeAgentAccount(ORG, 'agent-1')).toBe(true);
    expect(updated).toHaveLength(1);
    expect((updated.at(0)?.values as { revokedAt: Date } | undefined)?.revokedAt).toBeInstanceOf(
      Date,
    );
    expect(deleted).toEqual(['project_members', 'organization_members']);
    expect(deleted).not.toContain('users');
  });
});
