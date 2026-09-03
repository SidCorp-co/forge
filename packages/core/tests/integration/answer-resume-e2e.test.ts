/**
 * A human answer restarts the autonomous driver — against real Postgres.
 *
 * The session that asked the question is gone by the time anyone reads it, so
 * the answer is the only thing that can bring one back. Everything here is a
 * claim about which comments count, and each negative is a way the issue would
 * silently never restart (or restart when a person meant it to stay stopped).
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

  async function comment(issueId: string, actorType: 'user' | 'device'): Promise<void> {
    const { HooksBus } = await import('../../src/pipeline/hooks.js');
    const { registerAnswerResume } = await import('../../src/pipeline/answer-resume.js');
    const bus = new HooksBus();
    registerAnswerResume(bus);
    await bus.emit('commentCreated', {
      issueId,
      projectId,
      actor: { type: actorType, id: ownerId, agency: actorType === 'device' ? 'agent' : 'human' },
      commentId: randomUUID(),
      body: 'the answer',
    });
  }

  it('returns a needs_info issue to the driver when a person answers', async () => {
    await setMode('autonomous');
    const id = await insertIssue('needs_info');

    await comment(id, 'user');

    expect(await statusOf(id)).toBe('open');
  });

  // cm:guard the driver's own comments carry a `device` actor — if this ever passes, the agent's question resumes the issue it just parked and the pair loops with no human in it
  it('ignores the driver answering itself', async () => {
    await setMode('autonomous');
    const id = await insertIssue('needs_info');

    await comment(id, 'device');

    expect(await statusOf(id)).toBe('needs_info');
  });

  it('leaves a project whose config does not parse on needs_info', async () => {
    await setMode('unreadable');
    const id = await insertIssue('needs_info');

    await comment(id, 'user');

    expect(await statusOf(id)).toBe('needs_info');
  });

  // cm:guard this asserted the OPPOSITE until 2026-09-02, and it is kept rather than deleted because it is the only place the one-lane default is observable end to end: a project with an EMPTY config resumes on a human comment. If this ever reads `needs_info` again, something has started treating "declared nothing" as "declared another lane".
  it('resumes a project with an empty config, because there is one lane', async () => {
    await setMode(null);
    const id = await insertIssue('needs_info');

    await comment(id, 'user');

    expect(await statusOf(id)).toBe('open');
  });

  // cm:guard the autonomous board renders waiting/on_hold/needs_info alike as needs_human, but only needs_info was entered by the AGENT asking — resuming the other two takes a pause away from the person who chose it. ISS-886 made an agent's `waiting` unreachable on this mode, which narrows what these two rows represent (a human's pause, and the decompose review gate) without changing the rule: still not resumable by comment.
  it('never resumes the two parks a person entered deliberately', async () => {
    await setMode('autonomous');
    const waiting = await insertIssue('waiting');
    const onHold = await insertIssue('on_hold');

    await comment(waiting, 'user');
    await comment(onHold, 'user');

    expect(await statusOf(waiting)).toBe('waiting');
    expect(await statusOf(onHold)).toBe('on_hold');
  });
});
