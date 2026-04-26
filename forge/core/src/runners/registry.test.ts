import { describe, expect, it, beforeEach } from 'vitest';
import { z } from 'zod';
import {
  clearRunnerAdaptersForTest,
  getRunnerAdapter,
  listRunnerTypes,
  registerRunnerAdapter,
} from './registry.js';
import type { RunnerAdapter } from './types.js';

function makeAdapter(type: string): RunnerAdapter {
  const configSchema = z.object({}).passthrough();
  return {
    type,
    configSchema,
    validateConfig() {
      return { ok: true, config: {} };
    },
    async dispatch() {
      return { status: 'dispatched' };
    },
    async health() {
      return { ok: true };
    },
  };
}

describe('runners/registry', () => {
  beforeEach(() => {
    clearRunnerAdaptersForTest();
  });

  it('register + get round-trips an adapter', () => {
    const a = makeAdapter('test-x');
    registerRunnerAdapter(a);
    expect(getRunnerAdapter('test-x')).toBe(a);
  });

  it('listRunnerTypes returns all registered adapters', () => {
    registerRunnerAdapter(makeAdapter('one'));
    registerRunnerAdapter(makeAdapter('two'));
    expect(listRunnerTypes().map((a) => a.type).sort()).toEqual(['one', 'two']);
  });

  it('getRunnerAdapter returns undefined for unknown type', () => {
    expect(getRunnerAdapter('nope')).toBeUndefined();
  });
});
