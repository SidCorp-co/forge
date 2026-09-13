/**
 * An answer restarts the autonomous driver — against real Postgres.
 *
 * The session that asked is gone by the time anyone reads the question, so the
 * answer is the only thing that can bring one back. Every claim here is about
 * which answers count, and each negative is a way the issue would silently
 * never restart, or restart when a person meant it to stay stopped.
 *
 * It drove these same claims through a COMMENT until ISS-996 cut that lane.
 * The trigger changed and the claims did not: what may be resumed is a property
 * of the park rather than of the message that reaches it.
 *
 * Two claims went with the lane, and both were about a comment's AUTHOR: the
 * driver must not resume itself, and an agent on its owner's PAT reads as a
 * person on every field but `authored`. An answer carries no such field — it is
 * authorised instead, against a signed-in project role. What that does not yet
 * stop is an agent holding a person's credential answering the question it
 * asked, because a park's question records no asker to compare against.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

describe('answer-resume E2E', () => {
  let harness: TestDatabase;
  let ownerId: string;
  let projectId: string;
  let seq = 0;

  beforeAll(async () => {
    harness = await setupTestDatabase();
    process.env.DATABASE_URL = harness.url;
    process.env.NODE_ENV ??= 'test';
    process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
    process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  }, 60_000);

  afterAll(async () => {
    if (harness) await harness.cleanup();
  });

  beforeEach(async () => {
    await truncateAll(harness.db);
    const owner = await createTestUser(harness.db);
    ownerId = owner.id;
    projectId = (await createTestProject(harness.db, owner.id)).id;
  });

  // cm:guard `'unreadable'` writes a config the schema REJECTS, which since ISS-897 is the only shape that is not autonomous — `mode` is gone and `isAutonomous` collapsed to `cfg !== null`. Do not spell the negative case as a valid config with an unusual value; that parses, and the test would pass for the wrong reason.
  async function setMode(mode: 'autonomous' | 'unreadable' | null): Promise<void> {
    const pipelineConfig = mode === 'unreadable' ? { enabled: 'yes-please' } : { enabled: true };
    const agentConfig = mode === null ? {} : { pipelineConfig };
    await harness.db.execute(sql`
      UPDATE projects SET agent_config = ${JSON.stringify(agentConfig)}::jsonb
      WHERE id = ${projectId}
    `);
  }

  async function insertIssue(status: string): Promise<string> {
    const id = randomUUID();
    seq += 1;
    await harness.db.execute(sql`
      INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id)
      VALUES (${id}, ${projectId}, ${seq}, ${`issue ${seq}`}, ${status}, ${ownerId})
    `);
    return id;
  }

  async function statusOf(issueId: string): Promise<unknown> {
    const rows = await harness.db.execute(sql`SELECT status FROM issues WHERE id = ${issueId}`);
    return rows[0]?.status;
  }

  async function answer(issueId: string, by: 'human' | 'agent' = 'human'): Promise<void> {
    const { HooksBus } = await import('../../src/pipeline/hooks.js');
    const { registerAnswerResume } = await import('../../src/pipeline/answer-resume.js');
    const bus = new HooksBus();
    registerAnswerResume(bus);
    await bus.emit('questionAnswered', {
      questionId: randomUUID(),
      projectId,
      issueId,
      answeredBy: ownerId,
      body: by === 'agent' ? 'the agent answering itself' : 'the answer',
    });
  }

  it('returns a needs_info issue to the driver when the question is answered', async () => {
    await setMode('autonomous');
    const id = await insertIssue('needs_info');

    await answer(id);

    expect(await statusOf(id)).toBe('open');
  });

  it('leaves a project whose config does not parse on needs_info', async () => {
    await setMode('unreadable');
    const id = await insertIssue('needs_info');

    await answer(id);

    expect(await statusOf(id)).toBe('needs_info');
  });

  // cm:guard this asserted the OPPOSITE until 2026-09-02, and it is kept rather than deleted because it is the only place the one-lane default is observable end to end: a project with an EMPTY config resumes on a human comment. If this ever reads `needs_info` again, something has started treating "declared nothing" as "declared another lane".
  it('resumes a project with an empty config, because there is one lane', async () => {
    await setMode(null);
    const id = await insertIssue('needs_info');

    await answer(id);

    expect(await statusOf(id)).toBe('open');
  });

  // cm:guard the autonomous board renders waiting and needs_info alike as needs_human and `on_hold` as `paused` (ISS-970), but only needs_info was entered by the AGENT asking — resuming the other two takes a pause away from the person who chose it. ISS-886 made an agent's `waiting` unreachable on this mode, which narrows what these two rows represent (a human's pause, and the decompose review gate) without changing the rule: still not resumable by comment.
  it('never resumes the two parks a person entered deliberately', async () => {
    await setMode('autonomous');
    const waiting = await insertIssue('waiting');
    const onHold = await insertIssue('on_hold');

    await answer(waiting);
    await answer(onHold);

    expect(await statusOf(waiting)).toBe('waiting');
    expect(await statusOf(onHold)).toBe('on_hold');
  });
});
