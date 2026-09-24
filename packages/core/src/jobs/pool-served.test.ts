import { describe, expect, it, vi } from 'vitest';

vi.mock('../db/client.js', () => ({ db: {} }));
vi.mock('../lifecycle/transition.js', () => ({ applyKernelTransition: vi.fn() }));

const { noPromptMessage, poolPrompt, POOL_JOB_NO_PROMPT } = await import('./pool-served.js');

describe('poolPrompt', () => {
  it('reads a non-empty promptString as the prompt the pool briefs with', () => {
    expect(poolPrompt({ promptString: 'do the work' })).toBe('do the work');
  });

  it.each([
    ['a missing payload', null],
    ['a payload that is not an object', 'promptString'],
    ['no promptString', { kind: 'enrich' }],
    ['an empty promptString', { promptString: '' }],
    ['a whitespace-only promptString', { promptString: ' \n\t' }],
    ['a promptString that is not a string', { promptString: 42 }],
  ])('answers null for %s', (_label, payload) => {
    expect(poolPrompt(payload)).toBeNull();
  });
});

describe('noPromptMessage', () => {
  it('names the job type and the field that would make it runnable', () => {
    const message = noPromptMessage('pm');
    expect(message).toContain('`pm`');
    expect(message).toContain('promptString');
    expect(POOL_JOB_NO_PROMPT).toBe('POOL_JOB_NO_PROMPT');
  });
});
