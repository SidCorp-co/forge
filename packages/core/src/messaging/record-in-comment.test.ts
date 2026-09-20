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
