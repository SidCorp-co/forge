/**
 * ISS-645, REQ-4 BC-16 (ADR 0007): every sign-off records who signed and why, the accept of a
 * proposed revision included. An accept with no reason, a blank one or a whitespace-only one is
 * refused by name and writes nothing, whoever accepts: a person, or an agent the project's yolo gate
 * profile lets accept. On an agreed requirement the accept's reason is the re-baseline's. Through
 * the app's own routes against real Postgres.
 *
 * A reason no reader can see is no reason (ISS-645 r2, judge K144): one made only of zero-width,
 * format or space characters, which `trim()` leaves standing, is refused as a blank one is, by the
 * accept, the agree, the re-pin, the drop and the accept by decision alike.
 *
 * @direct-test-of packages/core/src/requirements/agree.ts
 * @direct-test-of packages/core/src/requirements/acceptance-rules.ts
 */

import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { api, patToken, userToken } from '../helpers/api.js';
import {
  addProjectMember,
  createTestProject,
  createTestUser,
  makeAgreeReady,
  rows,
  truncateAll,
} from '../helpers/factories.js';
import { seedProjectDocument } from '../helpers/release-world.js';

type Res = { status: number; body: Record<string, unknown> };

let projectId: string;
let ownerId: string;
let owner: string;
let agent: string;

beforeEach(async () => {
  await truncateAll();
  ownerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  owner = await userToken(ownerId);
  const bot = await createTestUser({ kind: 'agent' });
  await addProjectMember(projectId, bot.id, 'member');
  agent = await patToken(bot.id, [projectId]);
});

const on = (token: string, method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown) =>
  api(token, method, `/api/projects/${projectId}${path}`, body) as Promise<Res>;

async function ok(r: Promise<Res>): Promise<Record<string, unknown>> {
  const res = await r;
  expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
  return res.body;
}

const refusals = (r: Res) =>
  (
    (r.body.error as { refusals?: { code: string; path: string }[] } | undefined)?.refusals ?? []
  ).map((x) => `${x.code} ${x.path}`);

/** `REQ-n` with revision 1 proposed, every ready answer in. */
async function proposed(): Promise<string> {
  const by = owner;
  const made = await ok(
    on(by, 'POST', '/requirements', {
      title: 'Reminders reach the nurse',
      reason: 'planted',
      criteria: [{ body: 'A nurse sees the reminder' }],
    }),
  );
  const key = String(made.key);
  await makeAgreeReady(projectId, Number(key.slice(4)), ownerId);
  await ok(on(by, 'POST', `/requirements/${key}/revisions/1/propose`, {}));
  return key;
}

async function revisionOf(
  key: string,
  n: number,
): Promise<{ state: string; accept_reason: string | null }> {
  const [row] = await rows<{ state: string; accept_reason: string | null }>(sql`
    SELECT v.state, v.accept_reason FROM requirement_revisions v
      JOIN requirements r ON r.id = v.requirement_id
     WHERE r.project_id = ${projectId} AND r.req_seq = ${Number(key.slice(4))} AND v.revision = ${n}`);
  if (!row) throw new Error(`${key} has no revision ${n}`);
  return row;
}

const baselinesOf = (key: string) =>
  rows<{ revision: number; reason: string | null }>(sql`
    SELECT b.revision, b.reason FROM requirement_baselines b
      JOIN requirements r ON r.id = b.requirement_id
     WHERE r.project_id = ${projectId} AND r.req_seq = ${Number(key.slice(4))}
     ORDER BY b.revision, b.seq`);

/** The project's gate profile, through the gates door with a reason, as a person sets it. */
async function profile(name: 'yolo'): Promise<void> {
  await seedProjectDocument(projectId, ownerId, {
    environments: {
      beta: { tier: 'staging', deploysFrom: 'main', deployment: { mode: 'external' } },
    } as never,
  });
  const read = await ok(on(owner, 'GET', '/gates'));
  await ok(
    on(owner, 'PUT', '/gates', {
      baseRevision: read.revision,
      profile: name,
      overrides: {},
      reason: `planted: ${name} for the accept reason test`,
    }),
  );
}

describe('accepting a proposed revision owes a reason (REQ-4 BC-16)', () => {
  it.each([
    ['no reason', {}],
    ['a null reason', { reason: null }],
    ['a blank reason', { reason: '' }],
    ['a whitespace-only reason', { reason: '   \n\t' }],
  ])('refuses %s by name and writes nothing', async (_label, body) => {
    const key = await proposed();
    const r = await on(owner, 'POST', `/requirements/${key}/revisions/1/accept`, body);
    expect(r.status, JSON.stringify(r.body)).toBe(422);
    expect(refusals(r)).toEqual(['REQUIREMENT_SIGNOFF_REASON_REQUIRED /reason']);
    expect(await revisionOf(key, 1)).toEqual({ state: 'proposed', accept_reason: null });
  });

  it('takes a real reason and records it, trimmed, on the revision', async () => {
    const key = await proposed();
    await ok(
      on(owner, 'POST', `/requirements/${key}/revisions/1/accept`, {
        reason: '  BA review with the ward lead  ',
      }),
    );
    expect(await revisionOf(key, 1)).toEqual({
      state: 'current',
      accept_reason: 'BA review with the ward lead',
    });
  });

  it('holds an agent the yolo profile lets accept to the same rule', async () => {
    await profile('yolo');
    const key = await proposed();
    const bare = await on(agent, 'POST', `/requirements/${key}/revisions/1/accept`, {});
    expect(bare.status, JSON.stringify(bare.body)).toBe(422);
    expect(refusals(bare)).toEqual(['REQUIREMENT_SIGNOFF_REASON_REQUIRED /reason']);
    expect(await revisionOf(key, 1)).toEqual({ state: 'proposed', accept_reason: null });
    await ok(
      on(agent, 'POST', `/requirements/${key}/revisions/1/accept`, {
        reason: 'The owner asked the master to take it.',
      }),
    );
    expect(await revisionOf(key, 1)).toMatchObject({
      accept_reason: 'The owner asked the master to take it.',
    });
  });
});

describe('the re-baseline an accept writes records its reason (REQ-4 BC-16)', () => {
  it('writes the accept’s reason on the new baseline, and a refused accept writes none', async () => {
    const key = await proposed();
    await ok(on(owner, 'POST', `/requirements/${key}/revisions/1/accept`, { reason: 'BA review' }));
    await ok(
      on(owner, 'POST', `/requirements/${key}/agree`, { revision: 1, reason: 'owner signed r1' }),
    );
    const head = await ok(on(owner, 'GET', `/requirements/${key}`));
    const r1 = (head.revisions as Record<string, unknown>[]).find((x) => x.revision === 1) ?? {};
    await ok(
      on(owner, 'POST', `/requirements/${key}/revisions`, {
        baseRevision: 1,
        reason: 'The opt-out is a rule of its own.',
        spec: r1.spec,
        criteria: (r1.criteria as Record<string, unknown>[]).map((c) => ({
          code: c.code,
          body: c.body,
        })),
      }),
    );
    await ok(on(owner, 'POST', `/requirements/${key}/revisions/2/propose`, {}));

    const refused = await on(owner, 'POST', `/requirements/${key}/revisions/2/accept`, {
      reason: ' ',
    });
    expect(refusals(refused)).toEqual(['REQUIREMENT_SIGNOFF_REASON_REQUIRED /reason']);
    expect(await baselinesOf(key)).toEqual([{ revision: 1, reason: 'owner signed r1' }]);

    await ok(
      on(owner, 'POST', `/requirements/${key}/revisions/2/accept`, {
        reason: 'Ward lead signed the opt-out rule',
      }),
    );
    expect(await baselinesOf(key)).toEqual([
      { revision: 1, reason: 'owner signed r1' },
      { revision: 2, reason: 'Ward lead signed the opt-out rule' },
    ]);
    expect((await ok(on(owner, 'GET', `/requirements/${key}`))).status).toBe('agreed');
  });
});

/** Text `trim()` leaves standing and no reader can see: zero-width space, word joiner, BOM, filler. */
const INVISIBLE = ['\u200b', '\u200b\u2060\ufeff', ' \u3164 ', '\u00ad\u200e'];

const statusOf = async (key: string) =>
  String((await ok(on(owner, 'GET', `/requirements/${key}`))).status);

/** `REQ-n` agreed at revision 1, its one baseline written. */
async function agreed(): Promise<string> {
  const key = await proposed();
  await ok(on(owner, 'POST', `/requirements/${key}/revisions/1/accept`, { reason: 'BA review' }));
  await ok(
    on(owner, 'POST', `/requirements/${key}/agree`, { revision: 1, reason: 'owner signed r1' }),
  );
  return key;
}

describe('a reason no reader can see is refused as a blank one (REQ-4 BC-16, ISS-645 r2)', () => {
  it.each(INVISIBLE.map((r) => [JSON.stringify(r), r]))(
    'an accept with %s is refused and the revision stays proposed',
    async (_label, reason) => {
      const key = await proposed();
      const r = await on(owner, 'POST', `/requirements/${key}/revisions/1/accept`, { reason });
      expect(r.status, JSON.stringify(r.body)).toBe(422);
      expect(refusals(r)).toEqual(['REQUIREMENT_SIGNOFF_REASON_REQUIRED /reason']);
      expect(await revisionOf(key, 1)).toEqual({ state: 'proposed', accept_reason: null });
    },
  );

  it('an agree with a zero-width reason is refused and writes no baseline', async () => {
    const key = await proposed();
    await ok(on(owner, 'POST', `/requirements/${key}/revisions/1/accept`, { reason: 'BA review' }));
    const r = await on(owner, 'POST', `/requirements/${key}/agree`, {
      revision: 1,
      reason: '\u200b',
    });
    expect(r.status, JSON.stringify(r.body)).toBe(422);
    expect(refusals(r)).toEqual(['REQUIREMENT_SIGNOFF_REASON_REQUIRED /reason']);
    expect(await baselinesOf(key)).toEqual([]);
    expect(await statusOf(key)).toBe('draft');
  });

  it('a re-pin with a zero-width reason is refused and writes no baseline', async () => {
    const key = await agreed();
    const r = await on(owner, 'POST', `/requirements/${key}/repin`, {
      revision: 1,
      reason: '\u200b\u2060',
    });
    expect(r.status, JSON.stringify(r.body)).toBe(422);
    expect(refusals(r)).toEqual(['REQUIREMENT_SIGNOFF_REASON_REQUIRED /reason']);
    expect(await baselinesOf(key)).toEqual([{ revision: 1, reason: 'owner signed r1' }]);
  });

  it('a drop with a zero-width reason is refused and the requirement stays', async () => {
    const key = await proposed();
    const r = await on(owner, 'POST', `/requirements/${key}/drop`, { reason: '\u200b' });
    expect(r.status, JSON.stringify(r.body)).toBe(422);
    expect(refusals(r)).toEqual(['REQUIREMENT_DROP_REASON_REQUIRED /reason']);
    expect(await statusOf(key)).toBe('draft');
  });

  it('an accept by decision with a zero-width reason is refused and the requirement stays agreed', async () => {
    const key = await agreed();
    const r = await on(owner, 'POST', `/requirements/${key}/accept`, {
      revision: 1,
      reason: '\u200b',
      byDecision: true,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(422);
    expect(refusals(r)).toEqual(['REQUIREMENT_DECISION_REASON_REQUIRED /reason']);
    expect(await statusOf(key)).toBe('agreed');
  });

  it('a reason with words among the invisible characters still signs', async () => {
    const key = await proposed();
    await ok(
      on(owner, 'POST', `/requirements/${key}/revisions/1/accept`, { reason: '\u200bBA review' }),
    );
    expect(await revisionOf(key, 1)).toMatchObject({ state: 'current' });
  });
});
