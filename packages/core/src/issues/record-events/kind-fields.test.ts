// ISS-585 — a caller's decision record carries the fields a decision takes and no other; the refusal
// names the stranger at its pointer and every key a decision accepts. A kind with no declared set is
// unchanged, and a caller cannot post a withdrawal: core writes it in the withdraw act.
// @direct-test-of packages/core/src/issues/record-events/store.ts

import { DECISION_RECORD_FIELDS } from '@forge/contracts/record-events';
import { describe, expect, it } from 'vitest';
import { RefusalError } from '../../lib/refusal.js';
import { assertRecordEventDraft } from './store.js';

const refusalOf = (draft: Parameters<typeof assertRecordEventDraft>[0]) => {
  try {
    assertRecordEventDraft(draft);
    return null;
  } catch (err) {
    if (!(err instanceof RefusalError)) throw err;
    return err.refusals[0] ?? null;
  }
};

const field = (key: string) => ({ key, value: 'x' });

describe('the fields of a decision record', () => {
  it("takes the master's decision, why, until and every declared key", () => {
    expect(
      refusalOf({ kind: 'decision', contract: 1, fields: DECISION_RECORD_FIELDS.map(field) }),
    ).toBeNull();
  });

  it('refuses the first key outside the set at its pointer, naming every accepted key', () => {
    const r = refusalOf({
      kind: 'decision',
      contract: 1,
      fields: [field('decision'), field('probe'), field('x')],
    });
    expect([r?.code, r?.path]).toEqual(['EVENT_FIELD_UNKNOWN', '/fields/1/key']);
    for (const key of DECISION_RECORD_FIELDS) expect(r?.detail).toContain(`\`${key}\``);
  });

  it('leaves a kind with no declared set as it was', () => {
    expect(refusalOf({ kind: 'finding', contract: 1, fields: [field('probe')] })).toBeNull();
  });

  it('refuses a posted withdrawal as kernel evidence', () => {
    expect(refusalOf({ kind: 'withdrawal', contract: 1, fields: [field('withdraws')] })?.code).toBe(
      'EVENT_KIND_KERNEL_ONLY',
    );
  });
});
