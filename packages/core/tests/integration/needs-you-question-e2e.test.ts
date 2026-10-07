// A question a run asked that no issue, requirement or feedback holds can be answered only on the
// Agents screen, which nothing pointed to. It is a Questions row of Needs you for whoever may answer
// it, through the real read (readNeedsYou over readDetachedOpenQuestions), and on no one else's.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeWorld, startQueue, testEnv } from '../helpers/ecosystem-world.js';
import {
  addProjectMember,
  createTestIssue,
  createTestProject,
  createTestUser,
} from '../helpers/factories.js';

let projectId: string;
let ownerId: string;
let readerId: string;
let issueId: string;
let ask: typeof import('../../src/questions/index.js').askQuestion;
let readNeedsYou: typeof import('../../src/development/needs-you.js').readNeedsYou;

const viewer = (userId: string, mayWrite: boolean) => ({
  userId,
  agency: 'human' as const,
  isAdmin: mayWrite,
  mayApprove: mayWrite,
  mayWrite,
});

const free = (id: string, over: Record<string, unknown> = {}) =>
  ask({
    id,
    projectId,
    prompt: `the role catalogue ${id.slice(0, 4)}`,
    blockerKind: 'human',
    answer: { shape: 'free_text', needed: 'the roles' },
    ...over,
  });

beforeAll(async () => {
  testEnv();
  await import('../../src/index.js');
  await startQueue();
  ({ askQuestion: ask } = await import('../../src/questions/index.js'));
  ({ readNeedsYou } = await import('../../src/development/needs-you.js'));
  ownerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  readerId = (await createTestUser({ verified: true })).id;
  await addProjectMember(projectId, readerId, 'viewer');
  issueId = (
    await createTestIssue(projectId, ownerId, 1, { status: 'open', createdAt: new Date() })
  ).id;
}, 120_000);

afterAll(closeWorld);

describe('readNeedsYou with a question attached to nothing', () => {
  it('lists it as a Questions row for a writer, keyed by the question, and counts exactly the rows', async () => {
    const detached = randomUUID();
    await free(detached);
    const read = await readNeedsYou(projectId, viewer(ownerId, true));
    const rows = read.items.filter((i) => i.area === 'questions');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      entity: 'question',
      key: detached,
      title: expect.stringContaining('the role catalogue'),
      waitingOn: { kind: 'you', act: 'answer a question' },
    });
    expect(read.areas.questions.you).toBe(1);
    for (const [area, count] of Object.entries(read.areas)) {
      expect(read.items.filter((i) => i.area === area)).toHaveLength(count.you);
    }
  });

  it('leaves out a question on an issue, a machine-owned one, and a settled one', async () => {
    await free(randomUUID(), { issueId });
    await free(randomUUID(), { blockerKind: 'machine' });
    const { db } = await import('../../src/db/client.js');
    const { agentQuestions } = await import('../../src/db/schema-questions.js');
    const { eq } = await import('drizzle-orm');
    const settled = randomUUID();
    await free(settled);
    const { withKernelMarker } = await import('../../src/db/kernel-marker.js');
    await withKernelMarker(db, (tx) =>
      tx.update(agentQuestions).set({ status: 'void' }).where(eq(agentQuestions.id, settled)),
    );
    const rows = (await readNeedsYou(projectId, viewer(ownerId, true))).items.filter(
      (i) => i.area === 'questions',
    );
    expect(rows).toHaveLength(1);
  });

  it('is not a reader own row: someone who cannot answer it is not told it waits on them', async () => {
    const read = await readNeedsYou(projectId, viewer(readerId, false));
    expect(read.items.filter((i) => i.area === 'questions')).toHaveLength(0);
    expect(read.areas.questions.you).toBe(0);
  });
});
