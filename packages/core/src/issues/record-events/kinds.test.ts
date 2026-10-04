import * as CONTRACT from '@forge/contracts/record-events';
import { describe, expect, it } from 'vitest';
import { collapsibleActions } from './collapse.js';
import {
  COMMENT_INTENTS,
  KEPT_RECORD_KINDS,
  KERNEL_ONLY_RECORD_KINDS,
  KERNEL_RECORD_KINDS,
  NARRATION_RECORD_KINDS,
  RECORD_ACTIONS,
  RECORD_EVENT_KINDS,
} from './kinds.js';

describe('record retention: the kept set is a guard', () => {
  it('never lets a kernel kind into the narration collapse set', () => {
    const kernel = new Set<string>(KERNEL_RECORD_KINDS);
    expect(NARRATION_RECORD_KINDS.filter((kind) => kernel.has(kind))).toEqual([]);
  });

  it('keeps verdicts, transitions, landings, parks and corrections for good', () => {
    expect([...KERNEL_RECORD_KINDS].sort()).toEqual(
      ['correction', 'landing', 'park', 'transition', 'verdict'].sort(),
    );
  });

  it('refuses a collapse whose set names a kernel kind, naming it, before deleting anything', () => {
    expect(() => collapsibleActions(['fold', 'verdict'])).toThrow(
      /NARRATION_COLLAPSE_KERNEL_KIND: verdict is kernel evidence/,
    );
    expect(collapsibleActions()).toEqual([
      'record.fold',
      'record.routed',
      'record.gap',
      'record.baseline',
    ]);
  });

  it('partitions the closed set into kernel, narration and kept with nothing left over', () => {
    const parts = [...KERNEL_RECORD_KINDS, ...NARRATION_RECORD_KINDS, ...KEPT_RECORD_KINDS];
    expect(new Set(parts).size).toBe(parts.length);
    expect([...parts].sort()).toEqual([...RECORD_EVENT_KINDS].sort());
  });

  it('lets the table check admit every kind and the digest, and nothing else', () => {
    expect(RECORD_ACTIONS).toEqual([
      ...RECORD_EVENT_KINDS.map((k) => `record.${k}`),
      'record.digest',
    ]);
  });
});

describe('the browser copy of the vocabulary', () => {
  it('is identical to the one core enforces', () => {
    expect(CONTRACT.COMMENT_INTENTS).toEqual(COMMENT_INTENTS);
    expect(CONTRACT.RECORD_EVENT_KINDS).toEqual(RECORD_EVENT_KINDS);
    expect(CONTRACT.KERNEL_RECORD_KINDS).toEqual(KERNEL_RECORD_KINDS);
    expect(CONTRACT.KERNEL_ONLY_RECORD_KINDS).toEqual(KERNEL_ONLY_RECORD_KINDS);
    expect(CONTRACT.NARRATION_RECORD_KINDS).toEqual(NARRATION_RECORD_KINDS);
    expect(CONTRACT.KEPT_RECORD_KINDS).toEqual(KEPT_RECORD_KINDS);
  });
});
