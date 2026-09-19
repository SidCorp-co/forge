import { describe, expect, it } from 'vitest';
import { DEFAULT_NO_PROGRESS_ROUNDS, resolveNoProgressRounds } from './reopen-policy.js';

function cfg(noProgressRounds: unknown): unknown {
  return { pipelineConfig: { reopenPolicy: { noProgressRounds } } };
}

describe('resolveNoProgressRounds', () => {
  it('reads a configured value', () => {
    expect(resolveNoProgressRounds(cfg(12))).toBe(12);
  });

  it('falls back to the default on every unusable shape', () => {
    for (const bad of [undefined, null, 0, -1, 2.5, '5', {}, Number.NaN]) {
      expect(resolveNoProgressRounds(cfg(bad))).toBe(DEFAULT_NO_PROGRESS_ROUNDS);
    }
  });

  it('falls back when the config chain is absent entirely', () => {
    for (const bad of [undefined, null, {}, { pipelineConfig: {} }]) {
      expect(resolveNoProgressRounds(bad)).toBe(DEFAULT_NO_PROGRESS_ROUNDS);
    }
  });
});
