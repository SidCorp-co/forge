/**
 * The agent self service (ISS-1034): an id that is not one of the org's agents
 * reads as `undefined`, a handle with no row reads as an empty self, presence
 * is merged key by key with `null` unsetting one, and the merged whole is what
 * gets validated.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../config/env.js', () => ({ env: { NODE_ENV: 'test' } }));
const loadOrgAgent = vi.fn();
vi.mock('./agent-accounts.js', () => ({ loadOrgAgent: (...a: unknown[]) => loadOrgAgent(...a) }));

const stored: { row: Record<string, unknown> | null } = { row: null };
const upserts: unknown[] = [];
vi.mock('../db/client.js', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({ limit: async () => (stored.row ? [stored.row] : []) }),
      }),
    }),
    insert: () => ({
      values: (values: Record<string, unknown>) => ({
        onConflictDoUpdate: ({ set }: { set: Record<string, unknown> }) => ({
          returning: async () => {
            upserts.push({ values, set });
            stored.row = { ...(stored.row ?? {}), ...values, ...set, updatedAt: new Date(1) };
            return [stored.row];
          },
        }),
      }),
    }),
  },
}));

const { emptySelf, readAgentSelf, writeAgentSelf, agentSelfPatchSchema } = await import(
  './agent-selves.js'
);
const { PresenceValidationError } = await import('../conversations/presence.js');

const ORG = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const AGENT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ADMIN = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

beforeEach(() => {
  loadOrgAgent.mockReset();
  stored.row = null;
  upserts.length = 0;
});

describe('readAgentSelf', () => {
  it('is undefined for an id that is not one of the org’s agents', async () => {
    loadOrgAgent.mockResolvedValueOnce(null);
    expect(await readAgentSelf(ORG, AGENT)).toBeUndefined();
  });
  it('is an empty self, not a 404, for an agent that has written nothing', async () => {
    loadOrgAgent.mockResolvedValueOnce({ id: AGENT, handle: 'babo' });
    expect(await readAgentSelf(ORG, AGENT)).toEqual(emptySelf(AGENT));
    expect(emptySelf(AGENT).presence).toEqual({});
  });
});

describe('writeAgentSelf', () => {
  it('sets the text fields it is given and leaves the rest', async () => {
    loadOrgAgent.mockResolvedValue({ id: AGENT, handle: 'babo' });
    const self = await writeAgentSelf(ORG, AGENT, { soul: 'Patient, precise.' }, ADMIN);
    expect(self).toMatchObject({ userId: AGENT, soul: 'Patient, precise.', updatedBy: ADMIN });
    expect((upserts[0] as { set: Record<string, unknown> }).set).not.toHaveProperty('instructions');
  });

  it('merges presence key by key and unsets a key sent as null (no wholesale clobber)', async () => {
    loadOrgAgent.mockResolvedValue({ id: AGENT, handle: 'babo' });
    await writeAgentSelf(ORG, AGENT, { presence: { backoffAfter: 1, dormantMs: 120_000 } }, ADMIN);
    const after = await writeAgentSelf(
      ORG,
      AGENT,
      { presence: { backoffAfter: null, loopLimit: 2 } },
      ADMIN,
    );
    expect(after?.presence).toEqual({ dormantMs: 120_000, loopLimit: 2 });
  });

  it('validates the MERGED presence, so a stored key cannot hide a bad new one', async () => {
    loadOrgAgent.mockResolvedValue({ id: AGENT, handle: 'babo' });
    await writeAgentSelf(ORG, AGENT, { presence: { backoffAfter: 1 } }, ADMIN);
    await expect(
      writeAgentSelf(ORG, AGENT, { presence: { chatty: true } }, ADMIN),
    ).rejects.toBeInstanceOf(PresenceValidationError);
    await expect(
      writeAgentSelf(ORG, AGENT, { presence: { dormantMs: 1 } }, ADMIN),
    ).rejects.toBeInstanceOf(PresenceValidationError);
  });

  it('is undefined for an id that is not one of the org’s agents, writing nothing', async () => {
    loadOrgAgent.mockResolvedValueOnce(null);
    expect(await writeAgentSelf(ORG, AGENT, { soul: 'x' }, ADMIN)).toBeUndefined();
    expect(upserts).toHaveLength(0);
  });
});

describe('agentSelfPatchSchema', () => {
  it('refuses an empty patch and an unknown field', () => {
    expect(agentSelfPatchSchema.safeParse({}).success).toBe(false);
    expect(agentSelfPatchSchema.safeParse({ name: 'Babo' }).success).toBe(false);
  });
  it('bounds emoji and greeting', () => {
    expect(agentSelfPatchSchema.safeParse({ emoji: 'x'.repeat(17) }).success).toBe(false);
    expect(agentSelfPatchSchema.safeParse({ greeting: 'x'.repeat(501) }).success).toBe(false);
    expect(agentSelfPatchSchema.safeParse({ emoji: '🦞', greeting: 'hello' }).success).toBe(true);
  });
});
