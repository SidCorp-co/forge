/**
 * ISS-1113 — the fence refused by name, and the same sentence served as the
 * warning that reaches the fleet first.
 */

import { describe, expect, it } from 'vitest';
import { parseForgeRecord } from './forge-record.js';
import {
  destinationFor,
  ISSUE_ASSERTION_ROUTE,
  RECORD_GUIDE_SLUG,
  RECORD_RULE_IDS,
  recordInCommentRefusal,
  recordInCommentWarning,
  recordRefusals,
} from './record-screen.js';

const FENCE = '```';

const bodyOf = (kind: string | null): string =>
  [
    'The run judged criterion 3.',
    '',
    `${FENCE}forge-record`,
    'criterion: 3',
    'verdict: pass',
    FENCE,
    ...(kind === null ? [] : ['', `\`forge-record: ${kind} · contract 1\``]),
  ].join('\n');

describe('record-in-comment', () => {
  it('declares its own rule id beside field-budget', () => {
    expect(RECORD_RULE_IDS).toContain('record-in-comment');
  });

  it('refuses a fence under its own rule id', () => {
    const refusal = recordInCommentRefusal(parseForgeRecord(bodyOf('verdict')));
    expect(refusal?.rule).toBe('record-in-comment');
  });

  it('sends a verdict to the step-context route', () => {
    expect(destinationFor('verdict')).toBe('POST /api/issue-step-contexts');
    const refusal = recordInCommentRefusal(parseForgeRecord(bodyOf('verdict')));
    expect(refusal?.why).toContain('POST /api/issue-step-contexts');
    expect(refusal?.why).not.toContain('/attributes');
  });

  it('names no route for a kind no store holds whole, and says so', () => {
    for (const kind of ['baseline', 'decision', 'merged', 'somethingelse']) {
      expect(destinationFor(kind)).toBeNull();
      const why = recordInCommentRefusal(parseForgeRecord(bodyOf(kind)))?.why ?? '';
      expect(why).toContain('no store here holds');
      expect(why).toContain(ISSUE_ASSERTION_ROUTE);
      expect(why).not.toContain('issue-step-contexts');
    }
  });

  it('takes the unsupported path for a kind that names something on Object.prototype', () => {
    for (const kind of ['constructor', 'tostring', 'valueof']) {
      expect(destinationFor(kind)).toBeNull();
      const why = recordInCommentRefusal(parseForgeRecord(bodyOf(kind)))?.why ?? '';
      expect(why).toContain('no store here holds');
      expect(why).not.toContain('function');
    }
  });

  it('sends an untagged fence to the assertion route and the guide, never a guess', () => {
    const why = recordInCommentRefusal(parseForgeRecord(bodyOf(null)))?.why ?? '';
    expect(why).toContain('no store here holds');
    expect(why).toContain(RECORD_GUIDE_SLUG);
    expect(why).not.toContain('issue-step-contexts');
  });

  it('names the guide on every message, routed or not', () => {
    for (const kind of ['verdict', 'decision', 'somethingelse']) {
      expect(recordInCommentRefusal(parseForgeRecord(bodyOf(kind)))?.why).toContain(
        RECORD_GUIDE_SLUG,
      );
    }
  });

  it('serves the warning and the refusal off one sentence, so they cannot drift', () => {
    const record = parseForgeRecord(bodyOf('verdict'));
    expect(recordInCommentWarning(record)).toBe(recordInCommentRefusal(record)?.why);
  });

  it('says nothing at all about a body carrying no fence', () => {
    const plain = parseForgeRecord('Just a sentence somebody wrote for somebody to read.');
    expect(plain).toBeNull();
    expect(recordInCommentRefusal(plain)).toBeNull();
    expect(recordInCommentWarning(plain)).toBeNull();
  });
});

/**
 * The identity rule reaching the door `screenAgentComment` calls, rather than standing beside it.
 */
describe('recordRefusals carries the verdict identity and evidence rules', () => {
  const verdictBody = (lines: string[]): string =>
    [`${FENCE}forge-record`, ...lines, FENCE, '', '`forge-record: verdict · contract 1`'].join(
      '\n',
    );

  it('returns both refusals for a verdict naming nothing and citing nothing', async () => {
    const refusals = await recordRefusals(
      'proj-1',
      parseForgeRecord(verdictBody(['criterion: 13', 'verdict: pass'])),
      undefined,
    );
    expect(refusals.map((r) => r.rule)).toEqual(['verdict-identity', 'verdict-evidence']);
  });

  it('returns the evidence refusal for a verdict citing a path on the writing machine', async () => {
    const refusals = await recordRefusals(
      'proj-1',
      parseForgeRecord(
        verdictBody([
          'criterion: 13',
          'verdict: pass',
          'runtime: 33637c612ef15be6f924520c0d201a0889d8ed7e',
          'evidence: /tmp/claude-1000/scratchpad/c17-cleared.png',
        ]),
      ),
      undefined,
    );
    expect(refusals.map((r) => r.rule)).toEqual(['verdict-evidence']);
    expect(refusals[0]?.why).toContain('/tmp/claude-1000/scratchpad/c17-cleared.png');
  });

  it('returns nothing for a verdict naming a runtime in full and citing an attachment', async () => {
    const refusals = await recordRefusals(
      'proj-1',
      parseForgeRecord(
        verdictBody([
          'criterion: 13',
          'verdict: pass',
          'runtime: 33637c612ef15be6f924520c0d201a0889d8ed7e',
          'evidence: iss-1198-judge-log.txt',
        ]),
      ),
      undefined,
    );
    expect(refusals).toEqual([]);
  });

  it('returns nothing for a record of another kind that carries the same fields', async () => {
    const other = [
      `${FENCE}forge-record`,
      'criterion: 13',
      'verdict: pass',
      FENCE,
      '',
      '`forge-record: finding · contract 1`',
    ].join('\n');
    expect(await recordRefusals('proj-1', parseForgeRecord(other), undefined)).toEqual([]);
  });
});
