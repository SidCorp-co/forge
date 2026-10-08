/**
 * ISS-281 / FB-16: a person's accept reason is shown where the act is read. ISS-84 made every accept
 * route keep one; two were never read back: a delivery accept (kept only on its kernel transition, so
 * a requirement's Activity never listed it) and a feedback triage accepted from a suggestion (the
 * item's History showed the agent's note, not the person's reason). A drop, whose reason is required,
 * was missing from the Activity the same way.
 */

import { saidDisagreements } from '@forge/contracts/said';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  closeWorld,
  type Doc,
  ok,
  type Reply,
  requester,
  startQueue,
  testEnv,
} from '../helpers/ecosystem-world.js';
import { createTestProject, createTestUser, rows, seedIssueStatus } from '../helpers/factories.js';

let say: (who: 'owner', method: string, path: string, body?: unknown) => Promise<Reply>;
let projectId = '';
const at = (path: string) => `/api/projects/${projectId}${path}`;
const as = (method: string, path: string, body?: unknown) => say('owner', method, at(path), body);

async function requirement(title: string): Promise<string> {
  const key = ok(
    await as('POST', '/requirements', {
      title,
      reason: 'the rule it states',
      criteria: [{ body: 'A saved board shows every card it had.' }],
    }),
    201,
  ).key as string;
  ok(await as('POST', `/requirements/${key}/revisions/1/propose`, {}));
  return key;
}

const history = async (key: string): Promise<string[]> => {
  const entries = ok(await as('GET', `/requirements/${key}`)).history as Doc[];
  // each entry's kind, who and text are the registry sentences it says, so a reader in another language reads the same record
  expect(saidDisagreements(entries)).toEqual([]);
  return entries.map((e) => `${e.kind}: ${e.text}`);
};

beforeAll(async () => {
  testEnv();
  const { app } = await import('../../src/index.js');
  await startQueue();
  const { signUserToken } = await import('../../src/credentials/jwt.js');
  const owner = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(owner)).id;
  say = requester(app, { owner: await signUserToken(owner) });
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

describe("a requirement's Activity reads each accept with the signer's reason", () => {
  let req = '';

  beforeAll(async () => {
    req = await requirement('The board keeps its cards');
    ok(
      await as('POST', `/requirements/${req}/revisions/1/accept`, { reason: 'BA review on 6 Oct' }),
    );
    ok(await as('POST', `/requirements/${req}/agree`, { revision: 1, reason: 'owner signed r1' }));
    const proposed = ok(
      await as('POST', '/suggestions', {
        kind: 'breakdown',
        requirement: req,
        baseRevision: 1,
        payload: {
          issues: [
            {
              title: 'Save every card',
              criteria: [{ body: 'a reload shows every card', tracesTo: 'BC-1' }],
              complexity: 's',
              builds: null,
            },
          ],
        },
      }),
      201,
    );
    ok(
      await as('POST', `/suggestions/${proposed.suggestion.id}/accept`, {
        reason: 'one slice is enough, per the owner',
      }),
    );
    // The filed issue ships with its criterion passing, so the delivery can be accepted for real.
    const [filed] = await rows<{ issue_id: string; criterion_id: string }>(sql`
      SELECT c.issue_id, c.id AS criterion_id FROM issue_criteria c
        JOIN issues i ON i.id = c.issue_id
       WHERE i.project_id = ${projectId} AND c.requirement_criterion_id IS NOT NULL`);
    if (!filed) throw new Error('the breakdown accept filed no traced criterion');
    await rows(sql`
      INSERT INTO criterion_verdicts (criterion_id, issue_id, verdict, identity_kind, commit_sha, author_agency)
      VALUES (${filed.criterion_id}, ${filed.issue_id}, 'pass', 'commit', ${'a'.repeat(40)}, 'human')`);
    await rows(sql`UPDATE issues SET merged_at = now() WHERE id = ${filed.issue_id}`);
    await seedIssueStatus(filed.issue_id, 'closed');
    ok(
      await as('POST', `/requirements/${req}/accept`, {
        revision: 1,
        reason: 'UAT passed on staging',
      }),
    );
  });

  it('reads the revision accept, the agree and the suggestion accept with their reasons', async () => {
    expect(await history(req)).toEqual(
      expect.arrayContaining([
        'Decision: Accepted r1: BA review on 6 Oct',
        expect.stringMatching(/^Agreed: Agreed r1: owner signed r1/),
        'Decision: Accepted a breakdown: one slice is enough, per the owner',
      ]),
    );
  });

  it('lists the delivery accept, with its reason', async () => {
    expect(ok(await as('GET', `/requirements/${req}`)).status).toBe('accepted');
    expect(await history(req)).toContain('Decision: Accepted the delivery: UAT passed on staging');
  });

  it('lists a drop, with its reason', async () => {
    const dropped = await requirement('The board prints itself');
    ok(await as('POST', `/requirements/${dropped}/drop`, { reason: 'printing left the product' }));
    expect(await history(dropped)).toContain('Decision: Dropped: printing left the product');
  });
});

describe("a feedback item's History reads the person's reason on a triage a suggestion wrote", () => {
  let fb = '';
  let carrier = '';

  beforeAll(async () => {
    fb = ok(
      await as('POST', '/feedback', {
        kind: 'bug',
        title: 'Saving loses cards',
        screen: 'The board',
      }),
      201,
    ).feedback.key as string;
    carrier = ok(await as('POST', '/issues', { title: 'Save the cards' }), 201).displayId as string;
  });

  const suggest = async () =>
    ok(
      await as('POST', '/suggestions', {
        kind: 'feedback_triage',
        feedback: fb,
        baseRevision: null,
        payload: { route: 'issue', issue: carrier, note: 'the same crash as the save bug' },
      }),
      201,
    ).suggestion.id as string;

  it('shows the accept reason beside the agent note on the decision the accept wrote', async () => {
    const id = await suggest();
    ok(await as('POST', `/suggestions/${id}/accept`, { reason: 'support lead confirmed it' }));
    const [decision] = (ok(await as('GET', `/feedback/${fb}`)).feedback.decisions as Doc[]).filter(
      (d) => d.fromSuggestionId === id,
    );
    expect(decision).toMatchObject({
      reason: 'the same crash as the save bug',
      acceptReason: 'support lead confirmed it',
    });
  });

  it('reads no accept reason on a triage taken directly, with no suggestion behind it', async () => {
    const direct = ok(
      await as('POST', '/feedback', { kind: 'bug', title: 'Columns vanish', screen: 'The board' }),
      201,
    ).feedback.key as string;
    ok(await as('POST', `/feedback/${direct}/triage`, { route: 'issue', issue: carrier }));
    const [decision] = ok(await as('GET', `/feedback/${direct}`)).feedback.decisions as Doc[];
    expect(decision).toMatchObject({ fromSuggestionId: null, acceptReason: null });
  });
});
