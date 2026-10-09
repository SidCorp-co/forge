/**
 * A delivery whose only pass sits on a commit nobody could check against the live build (ISS-489).
 * Accepting it is refused, naming the criterion as not judged and why, until the live build is read
 * to hold that commit (round 3's judge: no test accepted while a line was unchecked, so dropping the
 * unchecked lines from the accept's proof stayed green). The requirement.delivered notice the close
 * could not raise, production being unreadable then, is raised by the sweep once a read can tell,
 * and only once.
 *
 * It reaches its subjects over HTTP and through the sweep the timer runs, so it names what it guards:
 * @direct-test-of packages/core/src/requirements/acceptance.ts
 * @direct-test-of packages/core/src/requirements/delivery-notice.ts
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sweepDeliveredRequirements } from '../../src/requirements/delivery-notice.js';
import {
  closeWorld,
  ok,
  type Reply,
  requester,
  settleOutbox,
  startQueue,
  testEnv,
} from '../helpers/ecosystem-world.js';
import { createTestProject, createTestUser, rows, seedIssueStatus } from '../helpers/factories.js';
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
    INSERT INTO criterion_verdicts (criterion_id, issue_id, verdict, identity_kind, commit_sha, author_agency)
    VALUES (${filed.criterion_id}, ${filed.issue_id}, 'pass', 'commit', ${JUDGED}, 'human')`);
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
    const refusals = (refused.json.error?.refusals ?? []) as { code: string; detail: string }[];
    expect(refusals.map((r) => r.code)).toEqual(['REQUIREMENT_CRITERIA_UNPROVEN']);
    expect(refusals[0]?.detail).toContain('BC-1 (not judged');
    expect(refusals[0]?.detail).toContain('could not be checked');
    expect(refusals[0]?.detail).toContain('the production probe timed out');
  });

  it('raises no delivered notice while production still cannot be read', async () => {
    expect(await sweepDeliveredRequirements()).toMatchObject({ raised: 0 });
    expect(await raisedEvents()).toEqual([]);
  });

  it('raises the notice once a later read reads it delivered, and only once', async () => {
    live(true);
    expect(await sweepDeliveredRequirements()).toMatchObject({ raised: 1 });
    expect(await sweepDeliveredRequirements()).toMatchObject({ raised: 0 });
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
