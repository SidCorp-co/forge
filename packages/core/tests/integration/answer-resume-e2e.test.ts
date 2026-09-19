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

  it('resumes a project with an empty config, because there is one lane', async () => {
    await setMode(null);
    const id = await insertIssue('needs_info');

    await answer(id);

    expect(await statusOf(id)).toBe('open');
  });

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
