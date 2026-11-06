/**
 * ISS-982 criterion 5 (sidpeak FB-502): work done on forge-beta lands under the beta key, so a twin's
 * merge mark naming that landing commit was refused COMMIT_NOT_THIS_ISSUE and sidpeak ISS-1/2 were
 * parked. The mark now takes a commit whose subject declares the beta key the issue's pair names, as
 * a twin or as the issue a ported Feedback item was routed to, read from the beta port's store. A
 * commit declaring neither key, or another pair's beta key, is still refused by name.
 *
 * @direct-test-of packages/core/src/issues/merge-identity.ts
 * @direct-test-of packages/core/src/issues/beta-provenance-port.ts
 * @direct-test-of packages/core/src/beta-port/store.ts
 * @direct-test-of packages/core/src/feedback/relations.ts
 * @direct-test-of packages/core/src/work-ports.ts
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { api } from '../helpers/api.js';
import { closeWorld, settleOutbox, startQueue, testEnv } from '../helpers/ecosystem-world.js';
import { createTestDevice } from '../helpers/factories.js';
import { BRANCH, issue, issueRow, rows, seedWorld, world } from '../helpers/host-merge-world.js';
import { messages } from '../helpers/planted-gitlab-merges.js';
import { boxToken } from '../helpers/preview-world.js';
import { TRIAGE_ANSWERS } from '../helpers/triage-answers.js';

vi.mock('../../src/integrations/source-host/resolve.js', async (importOriginal) => {
  const planted = await import('../helpers/planted-gitlab-merges.js');
  return {
    ...(await importOriginal<typeof import('../../src/integrations/source-host/resolve.js')>()),
    resolveSourceHost: async () => planted.plantedRepository(),
    sourceHostForBinding: async () => planted.plantedSourceHost(),
  };
});

beforeAll(async () => {
  testEnv();
  await startQueue();
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

let box = '';

const mark = (issueId: string, commit: string) =>
  api(box, 'POST', `/api/issues/${issueId}/merge`, {
    commit,
    target: BRANCH,
    mergedAt: '2026-11-04T09:00:00.000Z',
    note: 'landed on beta under its beta key',
  });

/** A beta pair naming `betaKey` for a dev issue: a twin. */
const twinPair = (betaKey: string, issueId: string) =>
  rows(sql`
    INSERT INTO beta_port_pairs (beta_issue_id, beta_key, beta_project_slug, dev_issue_id)
    VALUES (${randomUUID()}, ${betaKey}, 'sidpeak', ${issueId})`);

/** A beta pair naming `betaKey` for a Feedback item the beta issue was ported as. */
const feedbackPair = (betaKey: string, feedbackId: string) =>
  rows(sql`
    INSERT INTO beta_port_pairs (beta_issue_id, beta_key, beta_project_slug, dev_feedback_id)
    VALUES (${randomUUID()}, ${betaKey}, 'sidpeak', ${feedbackId})`);

describe('a twin’s mark reads its landing commit against the beta key its pair names', () => {
  beforeAll(async () => {
    await settleOutbox();
    await seedWorld(null);
    box = await boxToken(world.ownerId, await createTestDevice(world.ownerId));
  });

  it('takes a commit declaring the twin’s own beta key', async () => {
    const twin = await issue(1, 'in_progress');
    await twinPair('ISS-621', twin);
    const sha = 'a6'.repeat(20);
    messages.set(sha, 'fix(leave): the balance rounds half-days down (ISS-621)');

    const res = await mark(twin, sha);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await issueRow(twin))?.merged_commit_sha).toBe(sha);
  });

  // ISS-1017: the mark takes the agent's word, so a commit the repository does not vouch for as the
  // twin's is the mark's claim and its reading, never its observed landing
  it('reads a commit declaring neither key, or another pair’s beta key, as not the twin’s landing', async () => {
    const neither = 'b7'.repeat(20);
    messages.set(neither, 'fix(leave): an unrelated fix (ISS-777)');
    const other = 'c8'.repeat(20);
    messages.set(other, 'fix(leave): the sibling twin’s landing (ISS-621)');
    const named = 'd9'.repeat(20);
    // a body naming the key is no declaration: only the subject is read
    messages.set(named, 'chore: tidy\n\nRelated to ISS-620 on beta');

    for (const [seq, sha] of [
      [20, neither],
      [21, other],
      [22, named],
    ] as const) {
      const twin = await issue(seq, 'in_progress');
      await twinPair('ISS-620', twin);
      const res = await mark(twin, sha);
      expect(res.status, sha).toBe(200);
      expect((res.body as { commitReading: unknown }).commitReading, sha).toMatchObject({
        commit: sha,
        code: 'COMMIT_NOT_THIS_ISSUE',
      });
      expect((await issueRow(twin))?.merged_commit_sha, sha).toBeNull();
    }
  });

  it('takes a commit declaring the beta key of the Feedback item routed to the issue', async () => {
    const routed = await issue(3, 'in_progress');
    const filed = await api(world.token, 'POST', `/api/projects/${world.projectId}/feedback`, {
      kind: 'bug',
      title: 'Ported from beta ISS-630',
      screen: 'forge-beta ISS-630',
    });
    expect(filed.status, JSON.stringify(filed.body)).toBe(201);
    const fb = (filed.body as { feedback: { id: string; key: string } }).feedback;
    const triaged = await api(
      world.token,
      'POST',
      `/api/projects/${world.projectId}/feedback/${fb.key}/triage`,
      { answers: TRIAGE_ANSWERS, route: 'issue', issue: 'ISS-3' },
    );
    expect(triaged.status, JSON.stringify(triaged.body)).toBe(200);
    await feedbackPair('ISS-630', fb.id);
    const sha = 'e1'.repeat(20);
    messages.set(sha, 'fix(payroll): the export keeps its currency (ISS-630)');

    const res = await mark(routed, sha);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await issueRow(routed))?.merged_commit_sha).toBe(sha);
  });
});
