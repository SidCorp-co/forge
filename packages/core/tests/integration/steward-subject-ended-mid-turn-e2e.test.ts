// REQ-48 BC-6, judged on dev.683: the output checks of ISS-1240 (dev.682) and ISS-1241 (dev.683)
// read failed. Each issue was closed half a minute into its check's turn; the note door reads only
// open items, refused STEWARD_NOTE_SUBJECT_UNKNOWN, and the run ended failed, as if the check had
// broken. Nothing is owed an ended item: the run is skipped `subject_ended`, as one taken up after
// the end is. A refusal on an item still open still fails its run.
//
// @direct-test-of packages/core/src/steward/dispatch.ts

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { closeWorld, startQueue, testEnv } from '../helpers/ecosystem-world.js';
import { createTestIssue, createTestProject, createTestUser, rows } from '../helpers/factories.js';

const REFUSAL = 'PUT /api/projects/p/steward-notes/issue/ISS-1: STEWARD_NOTE_SUBJECT_UNKNOWN';
const turn = { closes: false };

vi.mock('../../src/steward/turn.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/steward/turn.js')>()),
  runGatewayAct: async ({ run }: { run: { subjectId: string } }) => {
    // the master closes the issue while the turn is reading it
    if (turn.closes) {
      const { db } = await import('../../src/db/client.js');
      const { withKernelMarker } = await import('../../src/db/kernel-marker.js');
      await withKernelMarker(db, (tx) =>
        tx.execute(sql`UPDATE issues SET status = 'closed' WHERE id = ${run.subjectId}`),
      );
    }
    return { refused: [REFUSAL], broken: [], acts: [], error: null };
  },
}));

let ownerId = '';

beforeAll(async () => {
  testEnv();
  await import('../../src/index.js');
  await startQueue();
  ownerId = (await createTestUser({ verified: true })).id;
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

describe('an output check whose issue ends during its turn', () => {
  async function checkRun(seq: number) {
    const pid = (await createTestProject(ownerId)).id;
    const issue = await createTestIssue(pid, ownerId, seq, {
      status: 'awaiting_release',
      createdAt: new Date(),
      mergedAt: new Date(),
    });
    const [made] = await rows<{ id: string }>(sql`
      INSERT INTO steward_runs (project_id, subject_kind, subject_id, subject_key, trigger, events,
                                acts_to_run, state, queued_at, not_before)
      VALUES (${pid}, 'issue', ${issue.id}, ${issue.key}, 'release.asked', '[]'::jsonb,
              ARRAY['output_check']::text[], 'queued', now() - interval '3 minutes',
              now() - interval '1 minute')
      RETURNING id`);
    return made?.id ?? '';
  }

  async function ended(runId: string) {
    const [run] = await rows<{
      state: string;
      skip_reason: string | null;
      failure: string | null;
    }>(sql`
      SELECT state, skip_reason, failure FROM steward_runs WHERE id = ${runId}`);
    return run;
  }

  it('is skipped subject_ended, never failed, when the issue was closed mid-turn', async () => {
    const { dispatchStewardRuns } = await import('../../src/steward/dispatch.js');
    turn.closes = true;
    const runId = await checkRun(1240);
    await dispatchStewardRuns(new Date(), { wait: true });
    expect(await ended(runId)).toMatchObject({
      state: 'skipped',
      skip_reason: 'subject_ended',
      failure: null,
    });
  });

  it('still fails when the door refused an issue that is still open', async () => {
    const { dispatchStewardRuns } = await import('../../src/steward/dispatch.js');
    turn.closes = false;
    const runId = await checkRun(1241);
    await dispatchStewardRuns(new Date(), { wait: true });
    const run = await ended(runId);
    expect(run?.state).toBe('failed');
    expect(run?.failure).toContain('STEWARD_NOTE_SUBJECT_UNKNOWN');
  });
});
