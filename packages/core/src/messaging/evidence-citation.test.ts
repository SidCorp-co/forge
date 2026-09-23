/**
 * What a verdict block cites, and the write door for a citation that can never resolve.
 */

import { describe, expect, it } from 'vitest';
import { citationForm, verdictEvidenceRefusals } from './evidence-citation.js';
import { parseForgeRecord } from './forge-record.js';
import { RECORD_RULE_IDS } from './record-screen.js';
import { criterionBlocksIn, verdictIdentityRefusals } from './verdict-identity.js';

const FENCE = '```';
const WHOLE = '33637c612ef15be6f924520c0d201a0889d8ed7e';

const record = (kind: string, lines: string[]): string =>
  [`${FENCE}forge-record`, ...lines, FENCE, '', `\`forge-record: ${kind} · contract 1\``].join(
    '\n',
  );

const blocksFor = (kind: string, lines: string[]) =>
  criterionBlocksIn(parseForgeRecord(record(kind, lines)));

const refusalsFor = (kind: string, lines: string[]) =>
  verdictEvidenceRefusals(parseForgeRecord(record(kind, lines)));

describe('the citations a criterion block carries', () => {
  it('attributes every evidence line, in order, to the criterion whose block it sits in', () => {
    const blocks = blocksFor('verdict', [
      'criterion: 1',
      'verdict: pass',
      `runtime: ${WHOLE}`,
      'evidence: first.txt',
      'evidence: second.png',
      'criterion: 2',
      'verdict: pass',
      `runtime: ${WHOLE}`,
      'evidence: third.txt',
    ]);
    expect(blocks.map((b) => b.cited)).toEqual([['first.txt', 'second.png'], ['third.txt']]);
  });

  it('attributes an evidence line above the first criterion line to no criterion', () => {
    const blocks = blocksFor('verdict', [
      'evidence: stray.txt',
      'criterion: 1',
      'verdict: pass',
      `runtime: ${WHOLE}`,
      'evidence: mine.txt',
    ]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.cited).toEqual(['mine.txt']);
  });

  it('opens no citation for an empty or whitespace evidence value', () => {
    const blocks = blocksFor('verdict', [
      'criterion: 1',
      'verdict: pass',
      `runtime: ${WHOLE}`,
      'evidence: ',
      'evidence:    ',
      'evidence: real.txt',
    ]);
    expect(blocks[0]?.cited).toEqual(['real.txt']);
  });
});

describe('what a citation is written as', () => {
  it('reads each form, trying them in the order the grammar states', () => {
    expect(citationForm('https://example.test/run.log')).toBe('url');
    expect(citationForm('http://example.test/run.log')).toBe('url');
    expect(citationForm('/tmp/claude-1000/scratchpad/c17-cleared.png')).toBe('machine-path');
    expect(citationForm('~/forge-local-docs/qa.md')).toBe('machine-path');
    expect(citationForm('file:///tmp/c17-cleared.png')).toBe('machine-path');
    expect(citationForm(WHOLE)).toBe('identity');
    expect(citationForm('afd83c9')).toBe('identity');
    expect(citationForm('packages/core/src/ws/server.test.ts')).toBe('in-tree');
    expect(citationForm('c17-cleared.png')).toBe('attachment');
  });

  it('reads a value once trimmed, so surrounding space changes nothing', () => {
    expect(citationForm('  /tmp/gone.png  ')).toBe('machine-path');
    expect(citationForm(`  ${WHOLE} `)).toBe('identity');
    expect(citationForm('  c17-cleared.png ')).toBe('attachment');
  });

  it('reads a hexadecimal value as an identity although it would be a legal file name', () => {
    expect(citationForm('deadbeef')).toBe('identity');
  });

  it('falls a value no earlier form takes through to an attachment name', () => {
    expect(citationForm('captures/my shot.png')).toBe('attachment');
    expect(citationForm('All four endpoints still 200 on the deployed core')).toBe('attachment');
    expect(citationForm('deadbeef.txt')).toBe('attachment');
  });
});

describe('verdict-evidence', () => {
  it('declares its own rule id beside the others this module owns', () => {
    expect(RECORD_RULE_IDS).toContain('verdict-evidence');
  });

  it('refuses a block whose verdict was taken by looking and which cites nothing, by number', () => {
    for (const verdict of ['pass', 'fail', 'short']) {
      const [refusal, ...rest] = refusalsFor('verdict', [
        'criterion: 13',
        `verdict: ${verdict}`,
        `runtime: ${WHOLE}`,
      ]);
      expect(rest).toEqual([]);
      expect(refusal?.rule).toBe('verdict-evidence');
      expect(refusal?.why).toContain('criterion 13');
      expect(refusal?.why).toContain(verdict);
      expect(refusal?.quote).toBe(`verdict: ${verdict}`);
    }
  });

  it('refuses a citation written as a machine-local path, naming the criterion and the value', () => {
    const [refusal, ...rest] = refusalsFor('verdict', [
      'criterion: 7',
      'verdict: pass',
      `runtime: ${WHOLE}`,
      'evidence: /tmp/claude-1000/scratchpad/c17-cleared.png',
    ]);
    expect(rest).toEqual([]);
    expect(refusal?.rule).toBe('verdict-evidence');
    expect(refusal?.why).toContain('criterion 7');
    expect(refusal?.why).toContain('/tmp/claude-1000/scratchpad/c17-cleared.png');
    expect(refusal?.quote).toBe('evidence: /tmp/claude-1000/scratchpad/c17-cleared.png');
  });

  it('refuses a machine-local path beside a citation that would have been fine', () => {
    const refusals = refusalsFor('verdict', [
      'criterion: 7',
      'verdict: pass',
      `runtime: ${WHOLE}`,
      'evidence: judge-log.md',
      'evidence: /tmp/gone.png',
    ]);
    expect(refusals).toHaveLength(1);
    expect(refusals[0]?.why).toContain('/tmp/gone.png');
  });

  it('does not refuse a skipped block that cites nothing', () => {
    expect(
      refusalsFor('verdict', ['criterion: 4', 'verdict: skipped', `runtime: ${WHOLE}`]),
    ).toEqual([]);
  });

  it('refuses a machine-local path on a skipped block all the same', () => {
    const refusals = refusalsFor('verdict', [
      'criterion: 4',
      'verdict: skipped',
      `runtime: ${WHOLE}`,
      'evidence: /tmp/gone.png',
    ]);
    expect(refusals).toHaveLength(1);
    expect(refusals[0]?.why).toContain('/tmp/gone.png');
  });

  it('carries the shape a citation takes and an example that itself passes the door', () => {
    const refusals = refusalsFor('verdict', [
      'criterion: 1',
      'verdict: pass',
      `runtime: ${WHOLE}`,
      'evidence: /tmp/gone.png',
    ]);
    expect(refusals).not.toHaveLength(0);
    for (const refusal of refusals) {
      expect(refusal.shape).toContain('evidence:');
      const example = parseForgeRecord(refusal.example);
      expect(verdictEvidenceRefusals(example)).toEqual([]);
      expect(verdictIdentityRefusals(example)).toEqual([]);
    }
  });

  it('refuses nothing on a record of another kind, whatever fields it carries', () => {
    for (const kind of ['review', 'baseline', 'correction']) {
      expect(
        refusalsFor(kind, ['criterion: 1', 'verdict: pass', 'evidence: /tmp/gone.png']),
      ).toEqual([]);
    }
  });

  it('refuses nothing of the shape `forge record verdict` writes today', () => {
    const shipped = refusalsFor('verdict', [
      'criterion: 31 — Every refusal the evidence rule returns carries the shape a citation takes.',
      'verdict: pass',
      'commit: aa2224db9cf6cf2c19d4dfa307b41f571900ac02',
      'evidence: iss-1187-judge-evidence.txt',
      'evidence: iss-1187-judge-probes.txt',
      'judge: a1cbc460-ad55-497e-be81-befa085fd8de',
      'judge-from: asked',
      'criterion: 32',
      'verdict: skipped',
      'commit: aa2224db9cf6cf2c19d4dfa307b41f571900ac02',
    ]);
    expect(shipped).toEqual([]);
  });
});
