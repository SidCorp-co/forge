import { describe, expect, it, vi } from 'vitest';

vi.mock('../config/env.js', () => ({
  env: { NODE_ENV: 'test', JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef' },
}));
vi.mock('../db/client.js', () => ({ db: {} }));

const resolveActors = vi.fn();
vi.mock('./actor-resolution.js', () => ({ resolveActors }));

const { __testing } = await import('./activity-routes.js');

const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const DEVICE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

type Row = Parameters<typeof __testing.attachActors>[0][number];

const row = (over: Partial<Row>): Row =>
  ({
    id: 'act-1',
    issueId: 'iss-1',
    action: 'status.changed',
    actorType: 'user',
    actorAgency: 'human',
    actorId: USER,
    payload: null,
    createdAt: new Date(),
    ...over,
  }) as Row;

function resolvesTo(isAgent: boolean, type: 'user' | 'device' = 'user') {
  resolveActors.mockResolvedValueOnce(
    new Map([
      [`${type}:${type === 'user' ? USER : DEVICE}`, { type, id: USER, displayName: 'x', isAgent }],
    ]),
  );
}

describe('the agent marker reads the row, not just the actor type', () => {
  it('marks a `user` row whose write was made by a machine', async () => {
    resolvesTo(false);
    const [out] = await __testing.attachActors([row({ actorAgency: 'agent' })]);
    expect(out?.actor?.isAgent).toBe(true);
  });

  it('leaves a genuine person alone', async () => {
    resolvesTo(false);
    const [out] = await __testing.attachActors([row({ actorAgency: 'human' })]);
    expect(out?.actor?.isAgent).toBe(false);
  });

  it('keeps the marker on a pre-column device row carrying the human default', async () => {
    resolvesTo(true, 'device');
    const [out] = await __testing.attachActors([
      row({ actorType: 'device', actorId: DEVICE, actorAgency: 'human' }),
    ]);
    expect(out?.actor?.isAgent).toBe(true);
  });

  it('gives the same user id different answers on different rows', async () => {
    resolveActors.mockResolvedValueOnce(
      new Map([[`user:${USER}`, { type: 'user', id: USER, displayName: 'x', isAgent: false }]]),
    );
    const out = await __testing.attachActors([
      row({ id: 'act-1', actorAgency: 'human' }),
      row({ id: 'act-2', actorAgency: 'agent' }),
    ]);
    expect(out.map((r) => r.actor?.isAgent)).toEqual([false, true]);
  });

  it('leaves an unresolvable actor null rather than guessing', async () => {
    resolveActors.mockResolvedValueOnce(new Map());
    const [out] = await __testing.attachActors([row({ actorAgency: 'agent' })]);
    expect(out?.actor).toBeNull();
  });
});
