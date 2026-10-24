// ISS-585 — what an intent correction may change, read as plain values: the intent it already has is
// refused by name, a decision needs its fields on a requirement, workflow or feedback item, and
// decision fields never ride on another intent.
// @direct-test-of packages/core/src/comments/entity-rules.ts
// @direct-test-of packages/core/src/comments/intent-edit.ts

import { describe, expect, it } from 'vitest';
import { editRefusals } from './entity-rules.js';
import { unchangedIntentRefusal } from './intent-edit.js';

const fields = { decision: 'Duplicate of FB-2', reason: 'Same refusal' };
const codes = (r: { code: string; path: string }[]) => r.map((x) => [x.code, x.path]);

describe('an issue comment intent correction', () => {
  it('refuses the intent the comment already has, and passes any other', () => {
    expect(unchangedIntentRefusal('note', 'note')?.code).toBe('COMMENT_INTENT_UNCHANGED');
    expect(unchangedIntentRefusal('note', 'question')).toBeNull();
  });
});

describe('an entity comment edit', () => {
  it('takes an intent alone', () => {
    expect(editRefusals('question', { intent: 'note' })).toEqual([]);
  });
  it('refuses an edit naming nothing', () => {
    expect(codes(editRefusals('note', {}))).toEqual([['COMMENT_BODY_REQUIRED', '']]);
  });
  it('refuses the intent it already has', () => {
    expect(codes(editRefusals('note', { intent: 'note' }))).toEqual([
      ['COMMENT_INTENT_UNCHANGED', '/intent'],
    ]);
  });
  it('refuses a turn into a decision without its fields, and takes it with them', () => {
    expect(codes(editRefusals('note', { intent: 'decision' }))).toEqual([
      ['COMMENT_DECISION_REQUIRED', '/decision'],
    ]);
    expect(editRefusals('note', { intent: 'decision', decision: fields })).toEqual([]);
  });
  it('refuses decision fields on a comment turning away from decision', () => {
    expect(codes(editRefusals('decision', { intent: 'note', decision: fields }))).toEqual([
      ['COMMENT_DECISION_INTENT_MISMATCH', '/decision'],
    ]);
    expect(editRefusals('decision', { intent: 'note' })).toEqual([]);
  });
});
