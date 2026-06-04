import { describe, expect, it } from 'vitest';
import { mergeProjectFacts } from './project-facts.js';

describe('mergeProjectFacts', () => {
  it('sets new keys onto an empty base', () => {
    expect(mergeProjectFacts(null, { 'build-commands': 'pnpm build' })).toEqual({
      'build-commands': 'pnpm build',
    });
  });

  it('merges per-key, leaving others untouched', () => {
    const base = { 'build-commands': 'old', 'git-remote': 'github' };
    expect(mergeProjectFacts(base, { 'build-commands': 'new' })).toEqual({
      'build-commands': 'new',
      'git-remote': 'github',
    });
  });

  it('removes a key when its value is null', () => {
    const base = { 'build-commands': 'x', 'git-remote': 'github' };
    expect(mergeProjectFacts(base, { 'git-remote': null })).toEqual({ 'build-commands': 'x' });
  });

  it('wipes the whole map when patch is null', () => {
    expect(mergeProjectFacts({ a: '1' }, null)).toBeNull();
  });

  it('is a no-op when patch is undefined', () => {
    expect(mergeProjectFacts({ a: '1' }, undefined)).toEqual({ a: '1' });
  });

  it('ignores reserved (derived) keys', () => {
    const r = mergeProjectFacts(
      {},
      { 'base-branch': 'main', 'test-urls': 'x', 'build-commands': 'pnpm build' },
    );
    expect(r).toEqual({ 'build-commands': 'pnpm build' });
  });

  it('treats a non-object existing value as empty base', () => {
    expect(mergeProjectFacts('garbage', { a: '1' })).toEqual({ a: '1' });
  });
});
