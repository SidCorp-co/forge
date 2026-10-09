// One intake draft (REQ-34 BC-11, BC-14..BC-16) driven with its reads and its model handed in, so
// every read it makes and every word the model is sent is seen. The drafting files are also read for
// what they import: a draft reaches requirements, workflows, feedback and releases, and nothing that
// holds an issue, a comment, a knowledge entry or the code.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ContentLanguageView } from '@forge/contracts/content-language';
import { describe, expect, it } from 'vitest';
import type { ChatMessage, CompletionAnswer } from '../integrations/llm/index.js';
import { type DraftDeps, draftIntake } from './draft.js';
import type { IntakeItem, IntakeReads, IntakeRecord } from './reads.js';

const item: IntakeItem = {
  kind: 'requirement',
  id: '00000000-0000-4000-8000-000000000009',
  projectId: '00000000-0000-4000-8000-000000000001',
  key: 'REQ-9',
  title: 'Match referrals by clinic code',
  lines: ['Title: Match referrals by clinic code'],
  authorId: '00000000-0000-4000-8000-000000000002',
  authorAgency: 'human',
};

const record = (ref: string, kind: IntakeRecord['kind'], line: string): IntakeRecord => ({
  ref,
  kind,
  key: ref.replace(/^(workflow|release):/, ''),
  title: line,
  lines: [`${ref}: ${line}`],
});

function readsSeen() {
  const calls: string[] = [];
  const withText: boolean[] = [];
  const reads: IntakeReads = {
    item: async () => {
      calls.push('item');
      return item;
    },
    requirements: async () => {
      calls.push('requirements');
      return [record('REQ-1', 'requirement', 'Referral import')];
    },
    workflows: async () => {
      calls.push('workflows');
      return [record('workflow:referral', 'workflow', 'Referral intake')];
    },
    feedback: async (_item, opts) => {
      calls.push('feedback');
      withText.push(opts.withText);
      return [record('FB-3', 'feedback', 'Import drops the clinic code')];
    },
    releases: async () => {
      calls.push('releases');
      return [record('release:1.2.0', 'release', 'Referral import shipped')];
    },
  };
  return { reads, calls, withText };
}

const question = (n: number) => ({
  prompt: `Question ${n}: does an uncoded referral wait?`,
  changes: 'outcome',
  options: [
    { id: 'wait', label: 'It waits', effect: 'A clerk matches it by hand' },
    { id: 'reject', label: 'It is rejected', effect: 'The clinic resends it' },
  ],
  recommended: 'wait',
});

const answerWith = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    fills: [{ field: 'summary', value: 'Referrals match by clinic code.', source: 'REQ-1' }],
    links: [
      { relation: 'duplicate', ref: 'REQ-1', why: 'Both match referrals.' },
      { relation: 'affected_workflow', ref: 'workflow:referral', why: 'Its match step.' },
      { relation: 'related_feedback', ref: 'FB-3', why: 'The lost code.' },
    ],
    questions: [question(1)],
    nothingToAsk: null,
    ...over,
  });

function modelSaying(...texts: (string | null)[]) {
  const sent: ChatMessage[][] = [];
  const complete = (async (_scope: unknown, messages: ChatMessage[]) => {
    sent.push(messages.map((m) => ({ ...m })));
    const text = texts.shift();
    if (text === null || text === undefined) {
      return {
        ok: false,
        miss: 'failed',
        detail: 'gateway is down',
        model: 'stub',
      } as CompletionAnswer;
    }
    return {
      ok: true,
      text,
      model: 'stub',
      usage: { promptTokens: 10, completionTokens: 5 },
    } as CompletionAnswer;
  }) as DraftDeps['complete'];
  return { complete, sent };
}

const language: ContentLanguageView = {
  contentLanguage: 'en',
  keepTermsInEnglish: [],
  source: 'default',
  revision: null,
};

const depsOf = (
  reads: IntakeReads,
  complete: DraftDeps['complete'],
  level: DraftDeps['level'] = 'off',
): DraftDeps => ({
  reads,
  complete,
  level,
  language,
  triageFault: () => null,
});

describe('an intake draft reads the product record and nothing else (BC-11)', () => {
  it('makes exactly the four reads, requirements, workflows, feedback and releases, and sends the model only what they returned', async () => {
    const { reads, calls } = readsSeen();
    const { complete, sent } = modelSaying(answerWith());
    const out = await draftIntake(item, depsOf(reads, complete));
    expect(out.outcome).toBe('drafted');
    expect(calls.sort()).toEqual(['feedback', 'releases', 'requirements', 'workflows']);
    expect(out.read).toEqual({ requirements: 1, workflows: 1, feedback: 1, releases: 1 });
    const user = sent[0]?.find((m) => m.role === 'user')?.content as string;
    for (const line of [
      'REQ-1: Referral import',
      'workflow:referral: Referral intake',
      'FB-3: Import drops the clinic code',
      'release:1.2.0: Referral import shipped',
    ]) {
      expect(user).toContain(line);
    }
    expect(user).not.toMatch(/ISS-\d|\bissue\b/i);
  });

  it('shows feedback by its key alone where the project keeps feedback from any model', async () => {
    const { reads, withText } = readsSeen();
    await draftIntake(item, depsOf(reads, modelSaying(answerWith()).complete, 'no_egress'));
    expect(withText).toEqual([false]);
  });

  it('imports nothing that holds an issue, a comment, a knowledge entry or the code', () => {
    const dir = __dirname;
    const drafting = readdirSync(dir).filter((f) =>
      ['reads.ts', 'draft.ts', 'prompt.ts', 'rules.ts'].includes(f),
    );
    expect(drafting.sort()).toEqual(['draft.ts', 'prompt.ts', 'reads.ts', 'rules.ts']);
    const allowedTables = new Set([
      '../db/schema-requirements.js',
      '../db/schema-workflows.js',
      '../db/schema-feedback.js',
      '../db/schema-release-highlights.js',
    ]);
    const faults: string[] = [];
    for (const file of drafting) {
      const src = readFileSync(join(dir, file), 'utf8');
      for (const m of src.matchAll(/import\s+(?:type\s+)?([\s\S]*?)\s+from\s+'([^']+)'/g)) {
        const [, names = '', from = ''] = m;
        if (from.startsWith('node:')) faults.push(`${file} imports ${from}`);
        if (/\/db\/schema/.test(from) && !allowedTables.has(from))
          faults.push(`${file} reads ${from}`);
        if (
          /\/(issues|comments|memory|git|integrations\/source-host|repo-projection|code-trace)(\/|\.)/.test(
            from,
          )
        ) {
          faults.push(`${file} imports ${from}`);
        }
        if (from === '../knowledge/index.js') {
          const named = names
            .replace(/[{}]/g, '')
            .split(',')
            .map((n) => n.trim())
            .filter(Boolean);
          for (const n of named) {
            if (!['itemEmbeddingOf', 'nearestItems'].includes(n))
              faults.push(`${file} reads knowledge ${n}`);
          }
        }
      }
    }
    expect(faults).toEqual([]);
  });
});

describe('an intake draft asks at most three questions, or says it has nothing to ask (BC-14..BC-16)', () => {
  it('refuses a fourth question by name and drafts from the answer that keeps to three', async () => {
    const { reads } = readsSeen();
    const { complete, sent } = modelSaying(
      answerWith({ questions: [question(1), question(2), question(3), question(4)] }),
      answerWith({ questions: [question(1), question(2), question(3)] }),
    );
    const out = await draftIntake(item, depsOf(reads, complete));
    expect(sent).toHaveLength(2);
    expect(sent[1]?.at(-1)?.content).toMatch(/^That was refused: questions: Too big/);
    expect(out.outcome === 'drafted' && out.draft.questions.map((q) => q.recommended)).toEqual([
      'wait',
      'wait',
      'wait',
    ]);
    expect(
      out.outcome === 'drafted' && out.draft.questions[0]?.options.map((o) => o.effect),
    ).toEqual(['A clerk matches it by hand', 'The clinic resends it']);
  });

  it('keeps the miss by name when the second answer is still wrong', async () => {
    const { reads } = readsSeen();
    const four = answerWith({ questions: [question(1), question(2), question(3), question(4)] });
    const out = await draftIntake(item, depsOf(reads, modelSaying(four, four).complete));
    expect(out.outcome === 'failed' && out.code).toBe('INTAKE_SHAPE');
  });

  it('says it has nothing to ask and asks nothing', async () => {
    const { reads } = readsSeen();
    const quiet = answerWith({ questions: [], nothingToAsk: 'The record settles every answer.' });
    const out = await draftIntake(item, depsOf(reads, modelSaying(quiet).complete));
    expect(out.outcome === 'drafted' && out.draft.questions).toEqual([]);
    expect(out.outcome === 'drafted' && out.draft.nothingToAsk).toBe(
      'The record settles every answer.',
    );
  });

  it('keeps a model that is down as a named miss, without a second call', async () => {
    const { reads } = readsSeen();
    const { complete, sent } = modelSaying(null);
    const out = await draftIntake(item, depsOf(reads, complete));
    expect(out.outcome === 'failed' && out.code).toBe('INTAKE_MODEL_FAILED');
    expect(sent).toHaveLength(1);
  });
});
