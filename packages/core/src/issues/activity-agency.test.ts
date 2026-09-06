/**
 * ISS-927 — the activity feed's agent marker, and the one property that let it
 * ship at all.
 *
 * The read path was deliberately deferred on 2026-09-02 (recorded on the issue
 * and, until this change, in `docs/proposals/agency-is-not-persisted.md`): every
 * row written before migration 0193 carries `actor_agency`'s `'human'` DEFAULT,
 * runner writes included, so a feed wired to the column ALONE would drop the
 * agent marker across the whole of history.
 *
 * What makes it shippable now is that the column can only ADD agents. The type
 * test stays as the floor, so no pre-column row moves; and it has to ship now,
 * because converting an unattended caller from a device token to a session PAT
 * moves its writes from `actor_type: 'device'` to `actor_type: 'user'` — without
 * the column those rows would newly read as a person's.
 *
 * Both halves are asserted here. Deleting either one is a silent regression in
 * a different direction, which is why neither is left to the other's test.
 */

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

  // cm:guard THE case the owner's deferral was protecting, and the reason the read path is an OR rather than a column read. Every row written before migration 0193 carries `'human'` by DEFAULT — including the runner writes `actor_type: 'device'` correctly calls agents. Replace the `||` with `row.actorAgency === 'agent'` and this goes red, which is the whole of what "no historical row changes" means.
  it('keeps the marker on a pre-column device row carrying the human default', async () => {
    resolvesTo(true, 'device');
    const [out] = await __testing.attachActors([
      row({ actorType: 'device', actorId: DEVICE, actorAgency: 'human' }),
    ]);
    expect(out?.actor?.isAgent).toBe(true);
  });

  // cm:guard agency is per ROW, not per actor, and this is the case that proves the decision was not folded into `resolveActors`' `(type, id)`-keyed map. One person legitimately appears as both: a comment they typed and a transition their session token made, in the same response. A map-level fold would give the whole batch whichever answer the last row carried.
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
