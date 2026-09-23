/**
 * The write door for what a verdict block names it was judged against.
 */

import { describe, expect, it } from 'vitest';
import { parseForgeRecord } from './forge-record.js';
import { RECORD_RULE_IDS } from './record-screen.js';
import { criterionBlocksIn, verdictIdentityRefusals } from './verdict-identity.js';

const FENCE = '```';
const WHOLE = '33637c612ef15be6f924520c0d201a0889d8ed7e';

const record = (kind: string, lines: string[]): string =>
  [`${FENCE}forge-record`, ...lines, FENCE, '', `\`forge-record: ${kind} · contract 1\``].join(
    '\n',
  );

const refusalsFor = (kind: string, lines: string[]) =>
  verdictIdentityRefusals(parseForgeRecord(record(kind, lines)));

describe('verdict-identity', () => {
  it('declares its own rule id beside the others this module owns', () => {
    expect(RECORD_RULE_IDS).toContain('verdict-identity');
  });

  it('refuses a criterion that carries a verdict and names nothing, by number', () => {
    const [refusal, ...rest] = refusalsFor('verdict', ['criterion: 13', 'verdict: pass']);
    expect(rest).toEqual([]);
    expect(refusal?.rule).toBe('verdict-identity');
    expect(refusal?.why).toContain('criterion 13');
    expect(refusal?.quote).toBe('criterion: 13');
  });

  it('carries the shape a block takes and a valid example on every refusal', () => {
    for (const refusal of refusalsFor('verdict', [
      'criterion: 1',
      'verdict: pass',
      'commit: nothex!',
    ])) {
      expect(refusal.shape).toContain('runtime:');
      expect(refusal.example).toContain('runtime: ');
    }
  });

  it('refuses an identity that is not written as one, naming the field and the value', () => {
    for (const value of ['', '   ', 'dce6f3', '0.17.1', '33637c61-2ef1-4be6-b924-520c0d201a08']) {
      const [refusal] = refusalsFor('verdict', [
        'criterion: 1',
        'verdict: pass',
        `commit: ${value}`,
      ]);
      expect(refusal?.why, `for ${JSON.stringify(value)}`).toContain('not written as an identity');
    }
  });

  it('refuses a runtime written as an abbreviation, naming the field and the value', () => {
    const [refusal] = refusalsFor('verdict', [
      'criterion: 4',
      'verdict: pass',
      'runtime: dce6f354c',
    ]);
    expect(refusal?.why).toContain('an abbreviation');
    expect(refusal?.quote).toBe('runtime: dce6f354c');
  });

  it('takes a runtime written in full', () => {
    expect(refusalsFor('verdict', ['criterion: 4', 'verdict: pass', `runtime: ${WHOLE}`])).toEqual(
      [],
    );
  });

  it('takes an abbreviated commit, so no verdict any shipped writer produces is refused', () => {
    expect(
      refusalsFor('verdict', [
        'criterion: 13 — The daemon log carries the three-way verdict.',
        'verdict: skipped',
        'commit: 06fa37c6d',
        'evidence: iss1114-crit13-attempt.txt',
        'judge: qa-judge-1114-verdicts',
        'judge-from: asked',
      ]),
    ).toEqual([]);
  });

  it('refuses each criterion of a many-block record on its own', () => {
    const refusals = refusalsFor('verdict', [
      'criterion: 1',
      'verdict: pass',
      `runtime: ${WHOLE}`,
      'criterion: 2',
      'verdict: pass',
      'criterion: 3',
      'verdict: pass',
      'runtime: dce6f354c',
    ]);
    expect(refusals.map((r) => r.quote)).toEqual(['criterion: 2', 'runtime: dce6f354c']);
  });

  it('leaves a criterion block that names no verdict alone', () => {
    expect(refusalsFor('verdict', ['criterion: 1', 'note: still running'])).toEqual([]);
  });

  it('refuses nothing in a record of another kind, whatever fields it carries', () => {
    expect(refusalsFor('confirmation', ['criterion: 1', 'verdict: pass'])).toEqual([]);
    expect(refusalsFor('finding', ['criterion: 1', 'verdict: pass', 'commit: x'])).toEqual([]);
  });
});

describe('criterionBlocksIn', () => {
  it('closes a block at the next criterion line, so a field belongs to the one above it', () => {
    expect(
      criterionBlocksIn(
        parseForgeRecord(
          record('verdict', [
            'criterion: 1',
            'verdict: pass',
            'criterion: 2',
            'verdict: fail',
            `runtime: ${WHOLE}`,
          ]),
        ),
      ),
    ).toEqual([
      { criterion: 1, verdict: 'pass', runtime: null, source: null },
      { criterion: 2, verdict: 'fail', runtime: WHOLE, source: null },
    ]);
  });

  it('keeps the first value where a field is repeated inside one block', () => {
    const [block] = criterionBlocksIn(
      parseForgeRecord(
        record('verdict', ['criterion: 1', 'verdict: pass', 'commit: aaaaaaa', 'commit: bbbbbbb']),
      ),
    );
    expect(block?.source).toBe('aaaaaaa');
  });

  it('holds nothing for a record that is not a verdict, and nothing for no record', () => {
    expect(criterionBlocksIn(parseForgeRecord(record('review', ['criterion: 1'])))).toEqual([]);
    expect(criterionBlocksIn(null)).toEqual([]);
  });

  it('opens no block on a criterion line that names no number', () => {
    expect(
      criterionBlocksIn(
        parseForgeRecord(record('verdict', ['criterion: all of them', 'verdict: pass'])),
      ),
    ).toEqual([]);
  });
});
