/**
 * REQ-41 BC-11 (QA of 0.4.0-dev.219): an issue parked after repeated failed run sessions waits on
 * its master, never on a person, and that holds for the rows parked BEFORE the cap parked for the
 * master. Seeds the old park through the kernel exactly as the old cap wrote it (a `needs_info`
 * agent park, `needs_decision`, a question minted), plus a person's own park and an issue carrying a
 * person's question beside the cap's; runs the boot re-home; reads the needs-me read and the
 * standing. A row whose park cannot be read is refused by name and leaves the marker unset.
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { api, userToken } from '../helpers/api.js';
import { closeWorld, startQueue, testEnv } from '../helpers/ecosystem-world.js';
import { createTestIssue, createTestProject, createTestUser, rows } from '../helpers/factories.js';

let projectId = '';
let ownerId = '';
let token = '';
let applyStatusTransition: typeof import('../../src/issues/index.js').applyStatusTransition;
let runRescueCapRehomeOnce: typeof import('../../src/issues/index.js').runRescueCapRehomeOnce;
let askQuestion: typeof import('../../src/questions/index.js').askQuestion;

const OLD_REASON =
  '3 run sessions ended on this issue without it moving on, so it has stopped rather than open another.';
const OLD_NEEDS =
  'Whether to send it back to the driver as it stands, or what to change first — answering returns the issue to the status it left.';

/** The cap's old park: an agent move to needs_info with a question minted, as before 0.4.0-dev.219. */
async function parkTheOldWay(seq: number, reason: string) {
  const issue = await createTestIssue(projectId, ownerId, seq, {
    status: 'open',
    createdAt: new Date(Date.now() - 3_600_000),
  });
  await applyStatusTransition(
    { id: issue.id, projectId, status: 'open', reopenCount: 0 },
    'needs_info',
    { id: ownerId, ownerId },
    {
      reason: 'autonomous_rescue_cap_reached',
      transitionReason: reason,
      needs: OLD_NEEDS,
      waitingKind: 'needs_decision',
    },
  );
  return issue;
}

const decisionKeys = async () => {
  const res = await api(token, 'GET', `/api/projects/${projectId}/needs-you/decisions`);
  expect(res.status).toBe(200);
  return (res.body.decisions as { key: string }[]).map((d) => d.key);
};
const standingOf = async (key: string) => {
  const res = await api(token, 'GET', `/api/projects/${projectId}/issues/standing/${key}`);
  expect(res.status).toBe(200);
  const body = res.body as {
    standing?: { waitingOn: { kind: string } };
    waitingOn?: { kind: string };
  };
  return (body.standing ?? body).waitingOn as { kind: string };
};
const statusOf = async (id: string) =>
  (await rows<{ status: string }>(sql`SELECT status FROM issues WHERE id = ${id}`))[0]?.status;
const openQuestions = (id: string) =>
  rows<{ id: string }>(
    sql`SELECT id FROM agent_questions WHERE issue_id = ${id} AND status = 'open'`,
  );

let capped = { id: '', key: '' };
let cappedBeside = { id: '', key: '' };
let personal = { id: '', key: '' };
let ownQuestion = '';

beforeAll(async () => {
  testEnv();
  await import('../../src/index.js');
  await startQueue();
  ({ applyStatusTransition, runRescueCapRehomeOnce } = await import('../../src/issues/index.js'));
  ({ askQuestion } = await import('../../src/questions/index.js'));
  ownerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  token = await userToken(ownerId);

  capped = await parkTheOldWay(801, OLD_REASON);
  cappedBeside = await parkTheOldWay(802, OLD_REASON);
  ownQuestion = crypto.randomUUID();
  await askQuestion({
    id: ownQuestion,
    projectId,
    issueId: cappedBeside.id,
    prompt: 'From the independent judge: is Half half of the large width?',
    blockerKind: 'human',
    answer: { shape: 'free_text', needed: 'the width rule', recommended: 'Half of the page.' },
  });
  personal = await parkTheOldWay(803, 'Needs the owner to say which staging URL the run checks.');
  await db.execute(sql`DELETE FROM backfill_markers WHERE key = 'rescue-cap-rehome'`);
}, 120_000);

afterAll(closeWorld);

describe('BC-11: a rescue-cap park made before the master park waits on the master', () => {
  it('plants the red: before the re-home the parks sit at needs_info and wait on a person', async () => {
    expect(await statusOf(capped.id)).toBe('needs_info');
    expect(await standingOf(capped.key)).toMatchObject({ kind: 'you' });
    expect(await decisionKeys()).toEqual(expect.arrayContaining([capped.key, cappedBeside.key]));
  });

  it('refuses by name a needs_info row whose park cannot be read, and leaves the marker unset', async () => {
    const stray = await createTestIssue(projectId, ownerId, 899, {
      status: 'needs_info',
      createdAt: new Date(),
      waitingKind: 'needs_decision',
    });
    const first = await runRescueCapRehomeOnce();
    expect(first?.refusals).toEqual([
      {
        issueId: stray.id,
        reason: expect.stringContaining('whether the rescue cap parked it cannot be read'),
      },
    ]);
    expect(first?.rehomed).toBe(2);
    const marker = await rows(sql`SELECT 1 FROM backfill_markers WHERE key = 'rescue-cap-rehome'`);
    expect(marker, 'a refused row keeps the marker unset so the next boot tries again').toEqual([]);
    await db.execute(sql`DELETE FROM issues WHERE id = ${stray.id}`);
  });

  it('moved the cap parks to on_hold through the kernel, waiting on the master, off Needs you', async () => {
    expect(await statusOf(capped.id)).toBe('on_hold');
    expect(await statusOf(cappedBeside.id)).toBe('on_hold');
    expect(await standingOf(capped.key)).toMatchObject({ kind: 'master' });
    const keys = await decisionKeys();
    expect(keys).not.toContain(capped.key);
    const [move] = await rows<{ from_status: string; to_status: string; reason: string }>(sql`
      SELECT from_status, to_status, reason FROM kernel_transitions
       WHERE entity = 'issue' AND entity_id = ${capped.id} ORDER BY created_at DESC, id DESC LIMIT 1`);
    expect(move).toMatchObject({ from_status: 'needs_info', to_status: 'on_hold' });
    expect(move?.reason).toContain('3 run sessions ended on this issue without it moving on');
    expect(move?.reason).toContain('waits on its master');
    expect(await openQuestions(capped.id), 'the question the park minted is voided').toEqual([]);
  });

  it("leaves another question on a re-homed issue open: it is somebody's own", async () => {
    expect((await openQuestions(cappedBeside.id)).map((q) => q.id)).toEqual([ownQuestion]);
    expect(await decisionKeys()).toContain(cappedBeside.key);
  });

  it("leaves a person's own needs_info where it is", async () => {
    expect(await statusOf(personal.id)).toBe('needs_info');
    expect(await decisionKeys()).toContain(personal.key);
  });

  it('is done once the refusal is settled: the next run moves nothing and sets the marker', async () => {
    const second = await runRescueCapRehomeOnce();
    expect(second).toMatchObject({ rehomed: 0, left: 1, refusals: [] });
    expect(await runRescueCapRehomeOnce(), 'a marked backfill does nothing').toBeNull();
  });
});
