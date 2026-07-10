import { describe, expect, it } from 'vitest';
import {
  mergeProjectFacts,
  mergeProjectFactsConfig,
  selectAlwaysInjectFacts,
} from './project-facts.js';

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
    expect(mergeProjectFacts(base, { 'git-remote': null })).toEqual({
      'build-commands': 'x',
    });
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
      {
        'base-branch': 'main',
        'test-urls': 'x',
        'build-commands': 'pnpm build',
      },
    );
    expect(r).toEqual({ 'build-commands': 'pnpm build' });
  });

  it('treats a non-object existing value as empty base', () => {
    expect(mergeProjectFacts('garbage', { a: '1' })).toEqual({ a: '1' });
  });
});

describe('mergeProjectFactsConfig', () => {
  it('sets a key config onto an empty base', () => {
    expect(
      mergeProjectFactsConfig(null, {
        'contracts-boundary': { alwaysInject: true },
      }),
    ).toEqual({
      'contracts-boundary': { alwaysInject: true },
    });
  });

  it('merges per-key, leaving others untouched', () => {
    const base = { a: { alwaysInject: true }, b: { alwaysInject: false } };
    expect(mergeProjectFactsConfig(base, { b: { alwaysInject: true } })).toEqual({
      a: { alwaysInject: true },
      b: { alwaysInject: true },
    });
  });

  it('removes a key config when its value is null', () => {
    const base = { a: { alwaysInject: true }, b: { alwaysInject: true } };
    expect(mergeProjectFactsConfig(base, { a: null })).toEqual({
      b: { alwaysInject: true },
    });
  });

  it('wipes the whole map when patch is null', () => {
    expect(mergeProjectFactsConfig({ a: { alwaysInject: true } }, null)).toBeNull();
  });

  it('is a no-op when patch is undefined', () => {
    expect(mergeProjectFactsConfig({ a: { alwaysInject: true } }, undefined)).toEqual({
      a: { alwaysInject: true },
    });
  });

  it('ignores reserved (derived) keys', () => {
    expect(
      mergeProjectFactsConfig(
        {},
        { 'base-branch': { alwaysInject: true }, a: { alwaysInject: true } },
      ),
    ).toEqual({ a: { alwaysInject: true } });
  });
});

describe('selectAlwaysInjectFacts', () => {
  it('returns only flagged keys paired with their full text, in map order', () => {
    const facts = { a: 'AAA', b: 'BBB', c: 'CCC' };
    const config = { a: { alwaysInject: true }, c: { alwaysInject: true } };
    expect(selectAlwaysInjectFacts(facts, config)).toEqual([
      { key: 'a', text: 'AAA' },
      { key: 'c', text: 'CCC' },
    ]);
  });

  it('excludes keys not flagged or flagged false', () => {
    const facts = { a: 'AAA', b: 'BBB' };
    const config = { a: { alwaysInject: false }, b: {} };
    expect(selectAlwaysInjectFacts(facts, config)).toEqual([]);
  });

  it('skips a flagged key whose text is missing or blank', () => {
    const facts = { a: '   ' };
    const config = { a: { alwaysInject: true }, ghost: { alwaysInject: true } };
    expect(selectAlwaysInjectFacts(facts, config)).toEqual([]);
  });

  it('skips reserved keys even if flagged', () => {
    const facts = { 'base-branch': 'main', a: 'AAA' };
    const config = {
      'base-branch': { alwaysInject: true },
      a: { alwaysInject: true },
    };
    expect(selectAlwaysInjectFacts(facts, config)).toEqual([{ key: 'a', text: 'AAA' }]);
  });

  it('tolerates non-object inputs', () => {
    expect(selectAlwaysInjectFacts(null, null)).toEqual([]);
    expect(selectAlwaysInjectFacts('x', 'y')).toEqual([]);
  });
});
