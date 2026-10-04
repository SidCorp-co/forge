import { describe, expect, it } from 'vitest';
import { assertRecordEventDraft, RecordEventRefused } from './store.js';

const field = { key: 'criterion', value: '1' };

function refusalOf(draft: Parameters<typeof assertRecordEventDraft>[0]): RecordEventRefused {
  try {
    assertRecordEventDraft(draft);
  } catch (err) {
    if (err instanceof RecordEventRefused) return err;
    throw err;
  }
  throw new Error('the draft was not refused');
}

describe('a record event draft is refused by name', () => {
  it('takes a closed kind with a contract and fields', () => {
    expect(() =>
      assertRecordEventDraft({ kind: 'landing', contract: 1, fields: [field] }),
    ).not.toThrow();
  });

  it('refuses a kernel kind a caller tries to author, naming the act that writes it', () => {
    const acts = {
      transition: 'POST /api/issues/:id/transition',
      park: '`needs_info` or `on_hold`',
      verdict: 'POST /api/issues/:id/verdicts',
    };
    for (const [kind, act] of Object.entries(acts)) {
      const err = refusalOf({ kind, contract: 1, fields: [field] });
      expect(err.code).toBe('EVENT_KIND_KERNEL_ONLY');
      expect(err.message).toContain(`\`${kind}\` is kernel evidence`);
      expect(err.message).toContain(act);
    }
  });

  it('refuses a kind outside the closed set, listing the set', () => {
    const err = refusalOf({ kind: 'merged', contract: 1, fields: [field] });
    expect(err.code).toBe('EVENT_KIND_UNKNOWN');
    expect(err.message).toContain('`merged` is not a record kind');
    expect(err.message).toContain('verdict, transition, landing, park, correction');
  });

  it('refuses the digest, which only the collapse writes', () => {
    expect(refusalOf({ kind: 'digest', contract: 1, fields: [field] }).code).toBe(
      'EVENT_KIND_UNKNOWN',
    );
  });

  it('refuses a contract that is not a positive whole number', () => {
    for (const contract of [0, -1, 1.5, Number.NaN]) {
      expect(refusalOf({ kind: 'park', contract, fields: [field] }).code).toBe(
        'EVENT_PAYLOAD_INVALID',
      );
    }
  });

  it('refuses no fields, and a field whose key is not a field name', () => {
    expect(refusalOf({ kind: 'park', contract: 1, fields: [] }).message).toContain(
      'carries no fields',
    );
    const bad = refusalOf({
      kind: 'park',
      contract: 1,
      fields: [{ key: 'Left Status', value: 'x' }],
    });
    expect(bad.code).toBe('EVENT_PAYLOAD_INVALID');
    expect(bad.message).toContain('fields[0].key `Left Status`');
  });
});
