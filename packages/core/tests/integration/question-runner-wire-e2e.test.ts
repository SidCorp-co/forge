/**
 * ISS-1210 — the body a box actually sends, taken through the door and read
 * back off the row it wrote.
 *
 * `src/devices/pool-routes-questions.test.ts` mocks the writer, so it holds a
 * claim about what the ROUTE forwards and none about what is stored: a writer
 * that dropped `needed` would pass it. The criterion is that the question reads
 * back carrying what the box asked, and only a real Postgres holds that.
 *
 * The bodies are the runner's own, read from
 * `crates/forge-runner-core/assets/question-ask-wire.jsonl`, which the runner's
 * suite asserts it puts on the wire. The two packages do not import each other,
 * so that file is the whole of what binds them — and a field renamed on one
 * side and not the other now fails at the row, not on a box where the question
 * silently never appears.
 */

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  createTestProject,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

const WIRE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../runner/crates/forge-runner-core/assets/question-ask-wire.jsonl',
);

/** What `forge-runner question ask` sends, in the order its own suite pins it. */
const sent = readFileSync(WIRE, 'utf8')
  .split('\n')
  .filter((l) => l.trim().length > 0)
  .map((l) => JSON.parse(l) as Record<string, unknown>);

const FREE_TEXT = sent[0] as Record<string, unknown>;
const CHOICE = sent[1] as Record<string, unknown>;

let harness: TestDatabase;
let schema: typeof import('../../src/db/schema-questions.js');
let app: typeof import('../../src/index.js').app;
let projectId: string;
let issueId: string;
let adminId: string;
let deviceId: string;
let deviceToken: string;

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.NODE_ENV ??= 'test';
  schema = await import('../../src/db/schema-questions.js');
  ({ app } = await import('../../src/index.js'));
}, 60_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
  adminId = (await createTestUser(harness.db)).id;
  projectId = (await createTestProject(harness.db, adminId)).id;
  issueId = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id)
    VALUES (${issueId}, ${projectId}, 1, 'the column', 'needs_info', ${adminId})
  `);
  const { pairDevice } = await import('../helpers/pair-device.js');
  const issued = await pairDevice({ ownerId: adminId, name: 'ask-box', platform: 'linux' });
  deviceId = issued.device.id;
  deviceToken = issued.plaintext;
  await harness.db.execute(sql`
    INSERT INTO runners (device_id, project_id, name, type, status)
    VALUES (${deviceId}, ${projectId}, 'ask-box', 'claude-code', 'online')
  `);
});

/** The runner's body, with the ids this database actually holds substituted in. */
function bodyOf(pinned: Record<string, unknown>, over: Record<string, unknown> = {}) {
  const body: Record<string, unknown> = {
    ...pinned,
    id: randomUUID(),
    projectId,
    ...over,
  };
  if (pinned.issueId !== undefined) body.issueId = issueId;
  return body;
}

async function ask(body: Record<string, unknown>) {
  const res = await app.request('/api/devices/me/questions', {
    method: 'POST',
    headers: { authorization: `Bearer ${deviceToken}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { res, body };
}

async function rowOf(id: string) {
  const [row] = await harness.db
    .select()
    .from(schema.agentQuestions)
    .where(eq(schema.agentQuestions.id, id))
    .limit(1);
  return row;
}

describe('the free-text round the runner pins', () => {
  it('is stored carrying the prompt, the need and the blocker kind the box sent', async () => {
    const { res, body } = await ask(bodyOf(FREE_TEXT));
    expect(res.status).toBe(200);
    const { questionId } = (await res.json()) as { questionId: string };

    const row = await rowOf(questionId);
    expect(row).toBeTruthy();
    expect(row?.blockerKind).toBe(FREE_TEXT.blockerKind);
    expect(row?.issueId).toBe(issueId);
    expect(row?.projectId).toBe(projectId);

    const step = row?.steps[0];
    expect(step?.prompt).toBe(body.prompt);
    expect(step?.answerShape).toBe('free_text');
    expect(step && !schema.isChoiceStep(step) ? step.needed : null).toBe(FREE_TEXT.needed);
  });
});

describe('the choice round the runner pins', () => {
  it('is stored with every option the box offered and the one it recommended', async () => {
    const { res } = await ask(bodyOf(CHOICE));
    expect(res.status).toBe(200);
    const { questionId } = (await res.json()) as { questionId: string };

    const step = (await rowOf(questionId))?.steps[0];
    expect(step && schema.isChoiceStep(step)).toBe(true);
    if (!step || !schema.isChoiceStep(step)) return;
    expect(step.options).toEqual(CHOICE.options);
    expect(step.recommendedOptionId).toBe(CHOICE.recommendedOptionId);
    expect(step.sensitive).toBe(true);
  });

  it('carries no issue, which is what puts a box’s own question on the Questions tab', async () => {
    const { res } = await ask(bodyOf(CHOICE));
    const { questionId } = (await res.json()) as { questionId: string };
    expect((await rowOf(questionId))?.issueId).toBeNull();

    const read = await import('../../src/questions/read.js');
    const listed = await read.projectQuestionsFor(projectId, adminId, 'open');
    expect(listed?.questions.map((q) => q.id)).toContain(questionId);
  });
});

describe('the read-back the box prints for itself', () => {
  it('serves this box the answer under the run identity its ask carried', async () => {
    const { res, body } = await ask(bodyOf(FREE_TEXT));
    const { questionId } = (await res.json()) as { questionId: string };

    const write = await import('../../src/questions/write.js');
    await write.answerQuestion({
      questionId,
      answer: { kind: 'text', text: 'keep the current name' },
      round: 1,
      by: adminId,
      role: 'admin',
    });

    const back = await app.request(
      `/api/devices/me/questions/${questionId}?runId=${String(body.runId)}`,
      { headers: { authorization: `Bearer ${deviceToken}` } },
    );
    expect(back.status).toBe(200);
    const { answer } = (await back.json()) as { answer: { text?: string } | null };
    expect(answer?.text).toBe('keep the current name');
  });

  it('reads as unanswered, not as missing, while nobody has answered', async () => {
    const { res, body } = await ask(bodyOf(FREE_TEXT));
    const { questionId } = (await res.json()) as { questionId: string };

    const back = await app.request(
      `/api/devices/me/questions/${questionId}?runId=${String(body.runId)}`,
      { headers: { authorization: `Bearer ${deviceToken}` } },
    );
    expect(back.status).toBe(200);
    expect(await back.json()).toEqual({ answer: null });
  });

  it('serves a run identity carrying query syntax, which the box must not have mangled', async () => {
    // `+`, `&`, `#` and a space are all legal in `question_waiters.run_id`,
    // which is plain text. Interpolated into the query string rather than
    // encoded, `+` arrives as a space and `&` ends the parameter, so the
    // lookup misses a question the box really did ask.
    for (const runId of ['run+7', 'run&7', 'run#7', 'run 7', 'run=7']) {
      const { res } = await ask(bodyOf(FREE_TEXT, { runId }));
      const { questionId } = (await res.json()) as { questionId: string };

      const back = await app.request(
        `/api/devices/me/questions/${questionId}?runId=${encodeURIComponent(runId)}`,
        { headers: { authorization: `Bearer ${deviceToken}` } },
      );
      expect(back.status, `run identity ${runId} was not served its own question`).toBe(200);
    }
  });

  it('404s a run identity this box never asked under, rather than serving the answer', async () => {
    const { res } = await ask(bodyOf(FREE_TEXT));
    const { questionId } = (await res.json()) as { questionId: string };

    const back = await app.request(`/api/devices/me/questions/${questionId}?runId=someone-else`, {
      headers: { authorization: `Bearer ${deviceToken}` },
    });
    expect(back.status).toBe(404);
  });

  it('registers no waiter at all for an empty run identity, which is why the verb refuses one', async () => {
    const { res } = await ask(bodyOf(FREE_TEXT, { runId: '' }));
    expect(res.status).toBe(200);
    const { questionId } = (await res.json()) as { questionId: string };

    const waiters = await harness.db.execute(
      sql`SELECT count(*)::int AS n FROM question_waiters WHERE question_id = ${questionId}`,
    );
    expect((waiters[0] as { n: number }).n).toBe(0);
  });
});
