/**
 * A requirement whose acceptance checklist is incomplete is refused naming each unmet item, and
 * that stays the default answer. A holder of the accept permission may accept it by decision with a
 * reason: the waived items are recorded on the move and posted as a decision on the requirement, it
 * reads "accepted by decision", leaves Needs you, the open standings and the duplicate check, and
 * never reads its criteria as proven.
 */

import { sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { mintPat } from '../../src/credentials/pat.js';
import { db } from '../../src/db/client.js';
import { api, type Body, userToken } from '../helpers/api.js';
import {
  addProjectMember,
  createTestProject,
  createTestUser,
  makeAgreeReady,
  rows,
} from '../helpers/factories.js';
import { seedProjectDocument } from '../helpers/release-world.js';

let owner = '';
let ownerId = '';
let unsigned = '';
let agent = '';
let projectId = '';

const at = (path: string) => `/api/projects/${projectId}${path}`;

type Refusal = { code: string; path: string; detail: string };

async function ok(res: Promise<{ status: number; body: Body }>, status = 200): Promise<Body> {
  const r = await res;
  expect(r.status, JSON.stringify(r.body)).toBe(status);
  return r.body;
}

async function refused(res: Promise<{ status: number; body: Body }>, status: number) {
  const r = await res;
  expect(r.status, JSON.stringify(r.body)).toBe(status);
  return (r.body.error as { refusals?: Refusal[] } | undefined)?.refusals ?? [];
}

async function withKernel(statement: ReturnType<typeof sql>): Promise<void> {
  const { withKernelMarker } = await import('../../src/db/kernel-marker.js');
  await withKernelMarker(db, (tx) => tx.execute(statement));
}

async function agreed(title: string): Promise<string> {
  const key = (
    await ok(
      api(owner, 'POST', at('/requirements'), {
        title,
        reason: 'buyers pay at the end',
        criteria: [{ body: 'A buyer pays by card at checkout.' }],
      }),
      201,
    )
  ).key as string;
  await makeAgreeReady(projectId, Number(key.slice(4)), ownerId);
  await ok(api(owner, 'POST', at(`/requirements/${key}/revisions/1/propose`), {}));
  await ok(api(owner, 'POST', at(`/requirements/${key}/revisions/1/accept`), { reason: 'ok' }));
  await ok(api(owner, 'POST', at(`/requirements/${key}/agree`), { revision: 1, reason: 'ok' }));
  return key;
}

async function linkedIssue(req: string, title: string): Promise<Body> {
  const issue = await ok(api(owner, 'POST', at('/issues'), { title, status: 'draft' }), 201);
  await ok(api(owner, 'POST', at(`/requirements/${req}/issues`), { issue: issue.id }));
  return issue;
}

const shipped = (issueId: string) =>
  withKernel(
    sql`UPDATE issues SET status = 'closed', merged_at = now() WHERE id = ${issueId as string}`,
  );

const accept = (req: string, body: Record<string, unknown>, token = owner) =>
  api(token, 'POST', at(`/requirements/${req}/accept`), { revision: 1, ...body });

const read = (req: string) => ok(api(owner, 'GET', at(`/requirements/${req}`)));

/** Gives `keys` one shared stored vector on `axis`; pairs on different axes are not near each other. */
async function sameVector(keys: string[], axis = 0): Promise<void> {
  const vector = `[${Array.from({ length: 1536 }, (_, i) => (i === axis ? 1 : 0)).join(',')}]`;
  for (const key of keys) {
    const id = (await read(key)).id as string;
    await db.execute(sql`
      INSERT INTO item_embeddings (project_id, requirement_id, version, model, embedding, content_hash, status)
      VALUES (${projectId}, ${id}, 1, 'test-model', ${vector}::vector, 'h', 'embedded')
      ON CONFLICT (item_type, item_id) DO UPDATE
        SET embedding = EXCLUDED.embedding, model = EXCLUDED.model, status = 'embedded', error = NULL
    `);
  }
}

beforeAll(async () => {
  ownerId = (await createTestUser({ verified: true })).id;
  owner = await userToken(ownerId);
  projectId = (await createTestProject(ownerId)).id;
  // accept is a person gate here: only a holder of requirements.approve accepts
  await seedProjectDocument(projectId, ownerId, {
    environments: {},
    extra: { approvals: { accept: true } },
  });
  const memberId = (await createTestUser({ verified: true })).id;
  await addProjectMember(projectId, memberId, 'member');
  unsigned = await userToken(memberId);
  const agentId = (await createTestUser({ kind: 'agent' })).id;
  await addProjectMember(projectId, agentId, 'member');
  await ok(
    api(owner, 'PATCH', `/api/projects/${projectId}/members/${agentId}`, {
      grants: ['requirements.approve'],
    }),
  );
  agent = (
    await mintPat({ permissions: ['*'], userId: agentId, name: 'master', projectIds: [projectId] })
  ).plaintext;
}, 120_000);

describe('accepting a requirement whose acceptance checklist is incomplete', () => {
  let req = '';
  let replacement = '';

  beforeAll(async () => {
    req = await agreed('Checkout takes a card');
    await shipped((await linkedIssue(req, 'take the card')).id as string);
    replacement = await agreed('Checkout takes every way to pay');
  }, 120_000);

  it('is refused by default, naming the unmet item', async () => {
    const codes = await refused(accept(req, { reason: 'looks done' }), 422);
    expect(codes.map((c) => [c.code, c.path])).toEqual([
      ['CHECKLIST_INCOMPLETE', '/answers/verdicts'],
    ]);
    expect(codes[0]?.detail).toContain('BC-1');
  });

  it('refuses a decision from someone without the accept permission', async () => {
    const r = await api(unsigned, 'POST', at(`/requirements/${req}/accept`), {
      revision: 1,
      reason: 'the owner said so',
      byDecision: true,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(403);
    expect((await read(req)).status).toBe('agreed');
    // the page offers the acts to whoever approvals.accept admits, and to nobody else
    expect((await ok(api(unsigned, 'GET', at(`/requirements/${req}`)))).canAccept).toBe(false);
    expect((await read(req)).canAccept).toBe(true);
  });

  it('refuses a decision with a blank reason', async () => {
    const codes = await refused(accept(req, { reason: '  ', byDecision: true }), 422);
    expect(codes.map((c) => c.code)).toEqual(['REQUIREMENT_DECISION_REASON_REQUIRED']);
    expect((await read(req)).status).toBe('agreed');
  });

  it('refuses a decision while a linked issue is unfinished, naming it', async () => {
    const other = await agreed('Checkout keeps a receipt');
    const open = await linkedIssue(other, 'print the receipt');
    const codes = await refused(
      accept(other, { reason: 'the owner said so', byDecision: true }, agent),
      422,
    );
    expect(codes.map((c) => c.code)).toEqual(['REQUIREMENT_HAS_UNFINISHED_ISSUES']);
    expect(codes[0]?.detail).toContain(open.displayId as string);
  });

  it('the replacement reads it as a near-duplicate while it stands agreed', async () => {
    await sameVector([req, replacement]);
    await ok(
      api(owner, 'POST', at(`/requirements/${replacement}/revisions`), {
        baseRevision: 1,
        reason: 'a wallet too',
        criteria: [{ code: 'BC-1', body: 'A buyer pays by card or wallet at checkout.' }],
      }),
    );
    await ok(api(owner, 'POST', at(`/requirements/${replacement}/revisions/2/propose`), {}));
    const codes = await refused(
      api(owner, 'POST', at(`/requirements/${replacement}/revisions/2/accept`), { reason: 'ok' }),
      422,
    );
    expect(codes.map((c) => c.code)).toContain('REQUIREMENT_DUPLICATE_UNDECIDED');
  });

  it('accepts by decision from a permitted agent token, recording what it waived', async () => {
    const body = await ok(
      accept(
        req,
        { reason: 'replaced by the payment rewrite; the owner closed it', byDecision: true },
        agent,
      ),
    );
    expect(body.status).toBe('accepted');

    const page = await read(req);
    const standing = page.standing as Body;
    expect(standing.state).toBe('accepted');
    expect(standing.acceptedByDecision).toMatchObject({
      reason: 'replaced by the payment rewrite; the owner closed it',
      waived: [expect.objectContaining({ question: 'verdicts' })],
    });
    // never read as proven
    expect((standing.coverage as Body[]).map((c) => c.verdict)).not.toContain('passing');
    expect((standing.facts as Body).passing).toBe(0);

    const [move] = await rows<{
      from_status: string;
      checklist_answers: Body[];
      actor_agency: string;
    }>(sql`
      SELECT from_status, checklist_answers, actor_agency FROM kernel_transitions
       WHERE entity = 'requirement' AND entity_id = ${page.id as string} AND to_status = 'accepted'`);
    expect(move?.from_status).toBe('agreed');
    expect(move?.actor_agency).toBe('agent');
    expect(move?.checklist_answers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ question: 'verdicts', provenance: 'waived' }),
        expect.objectContaining({ question: 'shipped', provenance: 'given' }),
      ]),
    );

    const [comment] = await rows<{ intent: string; body: string }>(sql`
      SELECT intent, body FROM comments WHERE requirement_id = ${page.id as string} AND intent = 'decision'`);
    expect(comment?.body).toContain('verdicts on the running build');
    expect(comment?.body).toContain('replaced by the payment rewrite');
  });

  it('leaves Needs you, the open standings and the active groups', async () => {
    const list = (await ok(api(owner, 'GET', at('/requirements')))).requirements as Body[];
    const row = list.find((r) => r.key === req) as Body;
    expect((row.standing as Body).attentionGroup).toBe('done');
    expect((row.standing as Body).acceptedByDecision).not.toBeNull();

    const needsYou = await ok(api(owner, 'GET', at('/needs-you')));
    expect((needsYou.items as Body[]).map((i) => i.key)).not.toContain(req);
    const standings = await ok(api(owner, 'GET', `/api/projects/${projectId}/standings`));
    expect((standings.standings as Body[]).map((s) => (s.subject as Body).key)).not.toContain(req);
  });

  it('no longer holds the replacement back as a near-duplicate', async () => {
    await ok(
      api(owner, 'POST', at(`/requirements/${replacement}/revisions/2/accept`), { reason: 'ok' }),
    );
    expect((await read(replacement)).currentRevision).toBe(2);
  });
});

describe('accepting revision N+1 of a near-duplicate with its pair decided at the head (ISS-776)', () => {
  const propose = (target: string, other: string, baseRevision: number) =>
    api(owner, 'POST', at('/suggestions'), {
      kind: 'duplicate',
      requirement: target,
      baseRevision,
      payload: { duplicateOf: other },
    });

  const reject = async (suggestion: Body) =>
    ok(
      api(owner, 'POST', at(`/suggestions/${(suggestion.suggestion as Body).id}/reject`), {
        reason: 'both stay',
      }),
    );

  const nextRevision = async (key: string, n: number) => {
    await ok(
      api(owner, 'POST', at(`/requirements/${key}/revisions`), {
        baseRevision: n - 1,
        reason: `revision ${n}`,
        criteria: [{ code: 'BC-1', body: `A buyer pays by card, variant ${n}.` }],
      }),
    );
    await ok(api(owner, 'POST', at(`/requirements/${key}/revisions/${n}/propose`), {}));
  };

  const acceptRevision = (key: string, n: number) =>
    api(owner, 'POST', at(`/requirements/${key}/revisions/${n}/accept`), { reason: 'ok' });

  let axis = 10;
  async function pair(): Promise<{ a: string; b: string }> {
    const a = await agreed('Checkout takes a card first');
    const b = await agreed('Checkout takes a card second');
    await sameVector([a, b], axis++);
    return { a, b };
  }

  it('is refused while the pair is undecided, naming the record it reads', async () => {
    const { b } = await pair();
    await nextRevision(b, 2);
    const codes = await refused(acceptRevision(b, 2), 422);
    expect(codes.map((c) => c.code)).toEqual(['REQUIREMENT_DUPLICATE_UNDECIDED']);
    expect(codes[0]?.detail).toContain('at revision 1');
  });

  it('is refused while the suggestion at the head is only proposed', async () => {
    const { a, b } = await pair();
    await ok(propose(b, a, 1), 201);
    await nextRevision(b, 2);
    const codes = await refused(acceptRevision(b, 2), 422);
    expect(codes.map((c) => c.code)).toEqual(['REQUIREMENT_DUPLICATE_UNDECIDED']);
  });

  it('accepts once the pair is decided at the head, the base create writes', async () => {
    const { a, b } = await pair();
    await reject(await ok(propose(b, a, 1), 201));
    await nextRevision(b, 2);
    await ok(acceptRevision(b, 2));
    expect((await read(b)).currentRevision).toBe(2);
  });

  it('a pair decided at revision 1 does not carry to the accept of revision 3', async () => {
    const { a, b } = await pair();
    await reject(await ok(propose(b, a, 1), 201));
    await nextRevision(b, 2);
    await ok(acceptRevision(b, 2));
    await nextRevision(b, 3);
    await sameVector([a, b], axis - 1); // an accepted revision re-embeds the head; plant its vector again
    const codes = await refused(acceptRevision(b, 3), 422);
    expect(codes.map((c) => c.code)).toEqual(['REQUIREMENT_DUPLICATE_UNDECIDED']);
    expect(codes[0]?.detail).toContain('at revision 2');
  });
});
