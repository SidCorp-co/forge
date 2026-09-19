// The screen a round passes at the ask, and the row a refused round does not leave.

import { describe, expect, it, vi } from 'vitest';
import type { QuestionOption } from '../db/schema-questions.js';

vi.mock('../ws/master-wake.js', () => ({ wakeMastersForAnswer: async () => ({}) }));

let inserts = 0;
vi.mock('../db/client.js', () => ({
  db: {
    select: () => ({
      from: () => ({ where: () => ({ limit: async () => [{ projectId: 'p1' }] }) }),
    }),
    insert: () => ({
      values: (v: { steps: unknown[] }) => {
        inserts += 1;
        return { returning: async () => [{ ...v, steps: v.steps }] };
      },
    }),
  },
}));

const { askQuestion, askParkQuestion, QuestionRefused } = await import('./write.js');
const { agentAuthoredSegments, screenRound } = await import('./screen.js');

function option(id: string, label: string): QuestionOption {
  return { id, label, authority: 'writer', bindsTo: 'session', executedBy: 'agent' };
}

function ask(prompt: string, label = 'go ahead') {
  return askQuestion({
    id: 'q1',
    projectId: 'p1',
    prompt,
    blockerKind: 'human',
    answer: { shape: 'choice', options: [option('a', label)], recommendedOptionId: 'a' },
  });
}

describe('a round is screened where the agent is still on the line', () => {
  it('takes a round whose prompt fits the cell', async () => {
    const before = inserts;
    await expect(ask('Which database should the migration target?')).resolves.toBeTruthy();
    expect(inserts).toBe(before + 1);
  });

  it('refuses a prompt that shouts at the whole room, and writes no row', async () => {
    const before = inserts;
    await expect(ask('@all which database should this target?')).rejects.toThrow(QuestionRefused);
    expect(inserts).toBe(before);
  });

  it('refuses a prompt carrying its own option list, because the round already has one', async () => {
    await expect(ask('Pick one:\n1. keep it\n2. drop it')).rejects.toThrow(/option/i);
  });

  it('refuses a prompt that spans lines', async () => {
    await expect(ask('Which database?\nThe one from last week.')).rejects.toThrow(QuestionRefused);
  });

  it('refuses an option LABEL that breaks the rules, not only the prompt', async () => {
    await expect(ask('Which database?', '@here the staging one')).rejects.toThrow(QuestionRefused);
  });

  it('names the rule, the shape and an example in what it throws', async () => {
    const err = await ask('Pick one:\n1. keep it').catch((e: Error) => e);
    expect(err).toBeInstanceOf(QuestionRefused);
    expect((err as Error).message).toMatch(/rule: /);
    expect((err as Error).message).toMatch(/shape: /);
    expect((err as Error).message).toMatch(/for example: /);
  });

  it('carries a code of its own, so a surface does not print it as a permissions error', async () => {
    const err: unknown = await ask('@all pick one').catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe('QUESTION_MESSAGE_REFUSED');
  });

  it("screens a park's question too — the park writes inside a transition's transaction", async () => {
    const executor = { insert: () => ({ values: () => ({ returning: async () => [{}] }) }) };
    await expect(
      askParkQuestion(executor as never, {
        id: 'q2',
        projectId: 'p1',
        issueId: 'i1',
        prompt: '@all what credential should this use?',
        needed: 'the credential name',
      }),
    ).rejects.toThrow(QuestionRefused);
  });

  it('reads the agent-authored strings of a round and not our own render of it', () => {
    const step = {
      round: 1,
      prompt: 'Which one?',
      askedAt: '2026-09-14T00:00:00.000Z',
      answerShape: 'choice' as const,
      options: [option('a', 'keep it'), option('b', 'drop it')],
      recommendedOptionId: 'a',
    };
    expect(agentAuthoredSegments(step)).toEqual(['Which one?', 'keep it', 'drop it']);
  });

  // `optionSuffix` interpolates the fingerprint verbatim into the posted line, and it is the field
  // that makes an option a permission — a typed number allows the call it names (ISS-978).
  it('reads the fingerprint of an option that binds to one call', () => {
    const step = {
      round: 1,
      prompt: 'Run it?',
      askedAt: '2026-09-14T00:00:00.000Z',
      answerShape: 'choice' as const,
      options: [
        { ...option('a', 'allow'), bindsTo: 'this_call' as const, fingerprint: 'POST /deploy#7f3' },
        option('b', 'refuse'),
      ],
      recommendedOptionId: 'a',
    };
    expect(agentAuthoredSegments(step)).toEqual(['Run it?', 'allow', 'POST /deploy#7f3', 'refuse']);
  });

  it('refuses a round whose fingerprint reshapes the line that states what is granted', () => {
    const refuse = vi.fn(() => {
      throw new Error('refused');
    });
    expect(() =>
      screenRound(
        {
          round: 1,
          prompt: 'Run it?',
          askedAt: '2026-09-14T00:00:00.000Z',
          answerShape: 'choice',
          options: [
            {
              ...option('a', 'allow'),
              bindsTo: 'this_call',
              fingerprint: 'POST /deploy\n2. and everything after it',
            },
          ],
          recommendedOptionId: 'a',
        },
        refuse as never,
      ),
    ).toThrow('refused');
    expect(refuse).toHaveBeenCalled();
  });

  it('hands a passing round back without calling the refusal', () => {
    const refuse = vi.fn();
    screenRound(
      {
        round: 1,
        prompt: 'Which credential?',
        askedAt: '2026-09-14T00:00:00.000Z',
        answerShape: 'free_text',
        needed: 'the credential name',
      },
      refuse as never,
    );
    expect(refuse).not.toHaveBeenCalled();
  });
});
