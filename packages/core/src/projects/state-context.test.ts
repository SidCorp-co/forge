import { describe, expect, it } from 'vitest';
import {
  budgetSchema,
  mergeStateContext,
  stateContextSchema,
} from './state-context.js';

describe('budgetSchema', () => {
  it('accepts a typical budget', () => {
    expect(
      budgetSchema.parse({ perRunUsd: 1, perMonthUsd: 50, action: 'pause' }),
    ).toEqual({ perRunUsd: 1, perMonthUsd: 50, action: 'pause' });
  });

  it('accepts zero for both amounts', () => {
    expect(
      budgetSchema.parse({ perRunUsd: 0, perMonthUsd: 0, action: 'warn' }),
    ).toEqual({ perRunUsd: 0, perMonthUsd: 0, action: 'warn' });
  });

  it('rejects negative perRunUsd', () => {
    expect(
      budgetSchema.safeParse({ perRunUsd: -1, perMonthUsd: 10, action: 'warn' }).success,
    ).toBe(false);
  });

  it('rejects negative perMonthUsd', () => {
    expect(
      budgetSchema.safeParse({ perRunUsd: 1, perMonthUsd: -1, action: 'warn' }).success,
    ).toBe(false);
  });

  it('rejects an unknown action', () => {
    expect(
      budgetSchema.safeParse({ perRunUsd: 1, perMonthUsd: 10, action: 'kill' }).success,
    ).toBe(false);
  });

  it('rejects perRunUsd above 1000', () => {
    expect(
      budgetSchema.safeParse({ perRunUsd: 1001, perMonthUsd: 10, action: 'warn' }).success,
    ).toBe(false);
  });

  it('rejects perMonthUsd above 100_000', () => {
    expect(
      budgetSchema.safeParse({ perRunUsd: 1, perMonthUsd: 100_001, action: 'warn' }).success,
    ).toBe(false);
  });

  it('rejects unknown keys (strict)', () => {
    expect(
      budgetSchema.safeParse({
        perRunUsd: 1,
        perMonthUsd: 10,
        action: 'warn',
        extra: 'nope',
      }).success,
    ).toBe(false);
  });
});

describe('stateContextSchema', () => {
  it('rejects an unknown state name', () => {
    expect(
      stateContextSchema.safeParse({
        unknown_state: { budget: { perRunUsd: 1, perMonthUsd: 10, action: 'warn' } },
      }).success,
    ).toBe(false);
  });

  it('accepts an entry with only budget', () => {
    const parsed = stateContextSchema.parse({
      code: { budget: { perRunUsd: 2, perMonthUsd: 200, action: 'pause' } },
    });
    expect(parsed?.code?.budget?.perRunUsd).toBe(2);
  });

  it('accepts an entry with blocks and modelOverride only', () => {
    const parsed = stateContextSchema.parse({
      plan: {
        blocks: { systemPrompt: 'use plan style' },
        modelOverride: 'claude-sonnet-4-6',
      },
    });
    expect(parsed?.plan?.modelOverride).toBe('claude-sonnet-4-6');
  });

  it('rejects unknown keys inside a state entry (strict)', () => {
    expect(
      stateContextSchema.safeParse({
        code: {
          budget: { perRunUsd: 1, perMonthUsd: 10, action: 'warn' },
          surprise: true,
        },
      }).success,
    ).toBe(false);
  });
});

describe('mergeStateContext', () => {
  it('leaves untouched states alone when patching a single state', () => {
    const existing = {
      plan: { blocks: { tip: 'hello' } },
    };
    const result = mergeStateContext(existing, {
      code: { budget: { perRunUsd: 1, perMonthUsd: 10, action: 'pause' } },
    });
    expect(result).toEqual({
      plan: { blocks: { tip: 'hello' } },
      code: { budget: { perRunUsd: 1, perMonthUsd: 10, action: 'pause' } },
    });
  });

  it('removes an entry when its value is null', () => {
    const existing = {
      code: { budget: { perRunUsd: 1, perMonthUsd: 10, action: 'pause' } },
      plan: { blocks: { tip: 'hi' } },
    };
    const result = mergeStateContext(existing, { code: null });
    expect(result).toEqual({ plan: { blocks: { tip: 'hi' } } });
  });

  it('wipes the whole stateContext when patch is null', () => {
    const existing = { code: { budget: { perRunUsd: 1, perMonthUsd: 10, action: 'pause' } } };
    expect(mergeStateContext(existing, null)).toBeNull();
  });

  it('keeps existing untouched when patch is undefined', () => {
    const existing = { code: { budget: { perRunUsd: 1, perMonthUsd: 10, action: 'pause' } } };
    expect(mergeStateContext(existing, undefined)).toEqual(existing);
  });

  it('treats non-object existing as empty', () => {
    expect(mergeStateContext(null, { code: { modelOverride: 'opus' } })).toEqual({
      code: { modelOverride: 'opus' },
    });
  });

  it('fully replaces a per-state entry (no deep merge of blocks/budget)', () => {
    const existing = {
      code: {
        blocks: { keep: true },
        budget: { perRunUsd: 1, perMonthUsd: 10, action: 'warn' },
      },
    };
    const result = mergeStateContext(existing, {
      code: { budget: { perRunUsd: 5, perMonthUsd: 100, action: 'pause' } },
    });
    expect(result).toEqual({
      code: { budget: { perRunUsd: 5, perMonthUsd: 100, action: 'pause' } },
    });
  });
});
