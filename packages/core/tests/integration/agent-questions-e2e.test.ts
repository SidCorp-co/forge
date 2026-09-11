/**
 * ISS-964 criteria 13, 14, 16, 20, 21, 22 — what a question is allowed to be.
 *
 * These need a real Postgres because every claim here is a refusal at WRITE
 * time: the shape is enforced by the write path and the constraints under it,
 * not by a type that a runner on another box never compiles against.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

let harness: TestDatabase;
let mods: typeof import('../../src/questions/write.js');
let ctx: { projectId: string; userId: string };

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.NODE_ENV ??= 'test';
  mods = await import('../../src/questions/write.js');
}, 60_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
  const user = await createTestUser(harness.db);
  const project = await createTestProject(harness.db, user.id);
  ctx = { projectId: project.id, userId: user.id };
});

function opt(list: { id: string }[], i: number) {
  const o = list[i];
  if (!o) throw new Error('the fixture has no option at that index');
  return o.id;
}

function anOption(over: Partial<Parameters<typeof mods.askQuestion>[0]['options'][number]> = {}) {
  return {
    id: crypto.randomUUID(),
    label: 'Take it',
    authority: 'writer' as const,
    bindsTo: 'session' as const,
    executedBy: 'agent' as const,
    ...over,
  };
}

function aQuestion(over: Partial<Parameters<typeof mods.askQuestion>[0]> = {}) {
  const options = over.options ?? [
    anOption(),
    anOption({ id: crypto.randomUUID(), label: 'Stop' }),
  ];
  return {
    id: crypto.randomUUID(),
    projectId: ctx.projectId,
    prompt: 'Push to a shared branch?',
    blockerKind: 'human' as const,
    options,
    recommendedOptionId: opt(options, 0),
    cost: { claimsHeld: 1, workspacesPinned: 1, dependents: 0 },
    ...over,
  };
}

describe('a question has one shape', () => {
  it('refuses a question with no recommended option', async () => {
    await expect(
      mods.askQuestion({ ...aQuestion(), recommendedOptionId: undefined as unknown as string }),
      'without a default the human owes a decision rather than a click, which is the whole reason the field is mandatory (ISS-964 criterion 14)',
    ).rejects.toThrow(/recommended/i);
  });

  it('refuses a recommendation that is not one of this question own options', async () => {
    await expect(
      mods.askQuestion({ ...aQuestion(), recommendedOptionId: crypto.randomUUID() }),
      'a recommendation pointing at nothing renders as no recommendation at all, which is criterion 14 failing silently instead of loudly',
    ).rejects.toThrow(/recommended/i);
  });

  // cm:guard `binds_to: this_call` IS the permission shape and there is no `kind` column saying so. An option that binds to ONE call must name which call, and the fingerprint is that name — a `kind` field would be a second answer to a question `binds_to` already answers (ISS-964 criteria 13 and 16).
  it('refuses an option bound to one call that does not name the call', async () => {
    const options = [anOption({ bindsTo: 'this_call' })];
    await expect(
      mods.askQuestion({ ...aQuestion({ options }), recommendedOptionId: opt(options, 0) }),
      'a permission with no fingerprint allows whatever the agent does next rather than the call that was blocked (ISS-964 criterion 16)',
    ).rejects.toThrow(/fingerprint/i);
  });

  it('refuses a permission answer presented for a DIFFERENT call, by name', async () => {
    const options = [anOption({ bindsTo: 'this_call', fingerprint: 'git push origin main' })];
    const q = await mods.askQuestion({
      ...aQuestion({ options }),
      recommendedOptionId: opt(options, 0),
    });
    await mods.answerQuestion({
      questionId: q.id,
      optionId: opt(options, 0),
      round: 1,
      by: ctx.userId,
      role: 'admin',
    });

    await expect(
      mods.checkPermission({ questionId: q.id, fingerprint: 'git push --force origin main' }),
      'a permission read as covering a call it was not asked about is a silent allow, which is the one outcome criterion 16 names',
    ).rejects.toThrow(/fingerprint/i);
    await expect(
      mods.checkPermission({ questionId: q.id, fingerprint: 'git push origin main' }),
    ).resolves.toBe(true);
  });
});

describe('a chain is one thread', () => {
  it('keeps a follow-up on the SAME row as a second step', async () => {
    const q = await mods.askQuestion(aQuestion());
    await mods.answerQuestion({
      questionId: q.id,
      optionId: q.recommendedOptionId,
      round: 1,
      by: ctx.userId,
      role: 'admin',
    });
    const again = await mods.askFollowUp({
      questionId: q.id,
      prompt: 'And the tag?',
      options: [anOption()],
    });

    expect(
      again.id,
      'a chain that mints a second row is N queue rows for one decision (ISS-964 criterion 20)',
    ).toBe(q.id);
    expect(again.steps.length).toBe(2);
    expect(await mods.openQuestionCount(ctx.projectId)).toBe(1);
  });

  it('refuses a fourth round and produces the thread as the record instead', async () => {
    let q = await mods.askQuestion(aQuestion());
    for (let round = 0; round < 2; round++) {
      await mods.answerQuestion({
        questionId: q.id,
        optionId: opt(q.steps.at(-1)?.options ?? [], 0),
        round: q.steps.length,
        by: ctx.userId,
        role: 'admin',
      });
      q = await mods.askFollowUp({
        questionId: q.id,
        prompt: `round ${round}`,
        options: [anOption()],
      });
    }
    await mods.answerQuestion({
      questionId: q.id,
      optionId: opt(q.steps.at(-1)?.options ?? [], 0),
      round: q.steps.length,
      by: ctx.userId,
      role: 'admin',
    });

    await expect(
      mods.askFollowUp({ questionId: q.id, prompt: 'once more', options: [anOption()] }),
      'a fourth question is the same conversation wearing a new row; the record is the thread (ISS-964 criterion 21)',
    ).rejects.toThrow(/max_rounds/);

    const after = await mods.getQuestion(q.id);
    expect(after?.status).toBe('needs_info');
    expect(after?.steps.length).toBe(3);
  });
});

describe('a premise that drifted', () => {
  it('voids the question WITH a reason and shrinks the queue', async () => {
    const q = await mods.askQuestion(aQuestion({ assumed: { issueStatus: 'developed' } }));
    expect(await mods.openQuestionCount(ctx.projectId)).toBe(1);

    await mods.voidQuestion({
      questionId: q.id,
      reason: 'issue moved to closed while the question was open',
    });

    const after = await mods.getQuestion(q.id);
    expect(after?.status).toBe('void');
    expect(
      after?.voidReason,
      'a question removed with no reason is indistinguishable from one nobody ever answered (ISS-964 criterion 22)',
    ).toMatch(/closed/);
    expect(await mods.openQuestionCount(ctx.projectId)).toBe(0);
  });
});
