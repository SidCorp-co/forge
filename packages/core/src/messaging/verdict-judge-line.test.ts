/**
 * ISS-1021 (FB-525) — a verdict fence's `judge:` line is read. It once fell through the block parser,
 * so every fenced verdict was recorded as QA's, and a reviewer run's was refused
 * VERDICT_JUDGE_NOT_RUN_ROLE with nothing it could write in the fence to fix it. A judge naming
 * neither `qa` nor `review` is refused by name, quoting its line.
 *
 * @direct-test-of packages/core/src/messaging/verdict-identity.ts
 * @direct-test-of packages/core/src/issues/criteria/verdict-input.ts
 */
import { describe, expect, it } from 'vitest';
import { draftFromBlock } from '../issues/criteria/verdict-input.js';
import { parseForgeRecord } from './forge-record.js';
import {
  type CriterionBlock,
  criterionBlocksIn,
  judgeLineRefusal,
  verdictIdentityRefusals,
} from './verdict-identity.js';

const SHA = '3641ba21fec5096e2d1a91a40f2d9e50e9239068';

const fence = (...lines: string[]) =>
  parseForgeRecord(['```forge-record: verdict · contract 1', ...lines, '```'].join('\n'));

const blocksOf = (...lines: string[]): CriterionBlock[] => criterionBlocksIn(fence(...lines));

const draftOf = (block: CriterionBlock | undefined) => {
  if (!block?.verdict) throw new Error('the fence held no verdict block');
  return draftFromBlock({ ...block, verdict: block.verdict });
};

describe("a verdict fence's judge line", () => {
  it.each(['review', 'qa'] as const)('carries `judge: %s` into the draft', (judge) => {
    const [block] = blocksOf('criterion: 2', 'verdict: pass', `judge: ${judge}`, `commit: ${SHA}`);
    expect(block?.judge).toBe(judge);
    expect(draftOf(block).judge).toBe(judge);
    expect(judgeLineRefusal(block as CriterionBlock)).toBeNull();
  });

  it('leaves the judge out of the draft where the block names none, for the recording run to own', () => {
    const [block] = blocksOf('criterion: 2', 'verdict: pass', `commit: ${SHA}`);
    expect(block?.judge).toBeNull();
    expect('judge' in draftOf(block)).toBe(false);
  });

  it('belongs to the criterion above it, never to the next block', () => {
    const [one, two] = blocksOf(
      'criterion: 1',
      'verdict: pass',
      'judge: review',
      `commit: ${SHA}`,
      'criterion: 2',
      'verdict: pass',
      `commit: ${SHA}`,
    );
    expect([one?.judge, two?.judge]).toEqual(['review', null]);
  });

  it.each(['bogus', 'Review', 'reviewer', ''])(
    'refuses `judge: %s` by name, quoting the line and naming both judges',
    (value) => {
      const record = fence('criterion: 2', 'verdict: pass', `judge: ${value}`, `commit: ${SHA}`);
      const refusals = verdictIdentityRefusals(record, []).filter(
        (r) => r.rule === 'verdict-judge',
      );
      expect(refusals).toHaveLength(1);
      const [refusal] = refusals;
      expect(refusal?.quote).toBe(`judge: ${value}`);
      expect(refusal?.why).toContain(`\`${value}\``);
      expect(refusal?.why).toContain('`qa`, `review`');
      expect(refusal?.why).toContain('criterion 2');
    },
  );

  it('never carries an unnamed judge into a draft as another', () => {
    const [block] = blocksOf('criterion: 2', 'verdict: pass', 'judge: bogus', `commit: ${SHA}`);
    expect(() => draftOf(block)).toThrow(/judge: bogus/);
  });
});
