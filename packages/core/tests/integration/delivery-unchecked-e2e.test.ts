/**
 * A delivery whose only pass sits on a commit nobody could check against the live build (ISS-489).
 * Accepting it is refused, naming the criterion as not judged and why, until the live build is read
 * to hold that commit (round 3's judge: no test accepted while a line was unchecked, so dropping the
 * unchecked lines from the accept's proof stayed green). The move to delivered is refused the same
 * way while production cannot be read, and once it can the move is taken by an act and raises the
 * requirement.delivered notice once (REQ-74 BC-8, BC-10): nothing raises it off a read.
 *
 * It reaches its subject over HTTP, so it names what it guards:
 * @direct-test-of packages/core/src/requirements/acceptance.ts
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  closeWorld,
  ok,
  type Reply,
  requester,
  settleOutbox,
  startQueue,
  testEnv,
} from '../helpers/ecosystem-world.js';
import {
  createTestProject,
  createTestUser,
  makeAgreeReady,
  rows,
  seedIssueStatus,
} from '../helpers/factories.js';
import { plantLiveBuild } from '../helpers/live-build.js';

const JUDGED = 'a'.repeat(40);

let say: (method: string, path: string, body?: unknown) => Promise<Reply>;
let projectId = '';
let req = '';
let requirementId = '';
let unplant: (() => void) | null = null;
const at = (path: string) => `/api/projects/${projectId}${path}`;

/** Production cannot be read, or serves `JUDGED`: the two worlds this file moves between. */
function live(readable: boolean): void {
  unplant?.();
  unplant = plantLiveBuild(readable ? JUDGED : { why: 'the production probe timed out' });
}

beforeAll(async () => {
  testEnv();
  const { app } = await import('../../src/index.js');
  live(false);
  await startQueue();
  const { signUserToken } = await import('../../src/credentials/jwt.js');
  const owner = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(owner)).id;
  const as = requester(app, { owner: await signUserToken(owner) });
  say = (method, path, body) => as('owner', method, at(path), body);

  req = ok(
    await say('POST', '/requirements', {
      title: 'The board keeps its cards',
      reason: 'the rule it states',
      criteria: [{ body: 'A saved board shows every card it had.' }],
    }),
    201,
  ).key as string;
  await makeAgreeReady(projectId, Number(req.slice(4)), owner);
  ok(await say('POST', `/requirements/${req}/revisions/1/propose`, {}));
  ok(await say('POST', `/requirements/${req}/revisions/1/accept`, { reason: 'BA review' }));
  ok(await say('POST', `/requirements/${req}/agree`, { revision: 1, reason: 'owner signed r1' }));
  const proposed = ok(
    await say('POST', '/suggestions', {
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
  ok(await say('POST', `/suggestions/${proposed.suggestion.id}/accept`, { reason: 'one slice' }));
  const [filed] = await rows<{
    issue_id: string;
    criterion_id: string;
    requirement_id: string;
  }>(sql`
    SELECT c.issue_id, c.id AS criterion_id, i.requirement_id FROM issue_criteria c
      JOIN issues i ON i.id = c.issue_id
     WHERE i.project_id = ${projectId} AND c.requirement_criterion_id IS NOT NULL`);
  if (!filed) throw new Error('the breakdown accept filed no traced criterion');
  requirementId = filed.requirement_id;
  await rows(sql`
    INSERT INTO criterion_verdicts (criterion_id, issue_id, verdict, identity_kind, commit_sha, author_agency, evidence)
    VALUES (${filed.criterion_id}, ${filed.issue_id}, 'pass', 'commit', ${JUDGED}, 'human',
            ARRAY['a reload of the saved board shows every card'])`);
  await rows(sql`UPDATE issues SET merged_at = now() WHERE id = ${filed.issue_id}`);
  await seedIssueStatus(filed.issue_id, 'closed');
  await settleOutbox();
}, 120_000);

afterAll(async () => {
  unplant?.();
  await closeWorld();
});

const raisedEvents = async () =>
  rows<{ revision: string }>(sql`
    SELECT payload ->> 'revision' AS revision FROM pipeline_outbox
     WHERE type = 'requirement.delivered' AND payload ->> 'requirementId' = ${requirementId}`);

describe('a delivery whose pass nobody could check against the live build', () => {
  it('is refused at the accept, naming the criterion not judged and why', async () => {
    const refused = await say('POST', `/requirements/${req}/accept`, { revision: 1 });
    expect(refused.status).toBe(422);
    const refusals = (refused.json.error?.refusals ?? []) as {
      code: string;
      path: string;
      detail: string;
    }[];
    // ISS-453: the acceptance checklist's verdicts question names it, on its own path
    expect(refusals.map((r) => [r.code, r.path])).toEqual([
      ['CHECKLIST_INCOMPLETE', '/answers/verdicts'],
    ]);
    expect(refusals[0]?.detail).toContain('BC-1 (not judged');
    expect(refusals[0]?.detail).toContain('could not be checked');
    expect(refusals[0]?.detail).toContain('the production probe timed out');
  });

  it('refuses the move to delivered while production cannot be read, naming the criterion', async () => {
    ok(await say('POST', `/requirements/${req}/start-delivery`, {}));
    const refused = await say('POST', `/requirements/${req}/mark-delivered`, {});
    expect(refused.status).toBe(422);
    const [refusal] = (refused.json.error?.refusals ?? []) as { code: string; detail: string }[];
    expect(refusal?.code).toBe('REQUIREMENT_CRITERIA_UNPROVEN');
    expect(refusal?.detail).toContain('BC-1 (not judged');
    expect(await raisedEvents()).toEqual([]);
  });

  it('is marked delivered by its act once the live build reads the commit held, raising the notice once', async () => {
    live(true);
    expect(await raisedEvents()).toEqual([]);
    ok(
      await say('POST', `/requirements/${req}/mark-delivered`, { reason: 'proven on production' }),
    );
    expect(await raisedEvents()).toEqual([{ revision: '1' }]);
    await settleOutbox();
    const told = await rows<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM notifications
       WHERE dedupe_key = ${`requirement-delivered:${requirementId}@r1`}`);
    expect(told[0]?.n).toBe(1);
  });

  it('is accepted once the live build reads the commit held', async () => {
    ok(await say('POST', `/requirements/${req}/accept`, { revision: 1, reason: 'UAT passed' }));
    expect(ok(await say('GET', `/requirements/${req}`)).status).toBe('accepted');
  });
});
