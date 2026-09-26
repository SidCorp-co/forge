import { describe, expect, it } from 'vitest';
import { releaseBranches } from './plan.js';

describe('releaseBranches', () => {
  it('promotes staging → master for a project that declares promote', () => {
    expect(releaseBranches({ baseBranch: 'staging', liveBranch: 'master' }, 'promote')).toEqual({
      baseBranch: 'staging',
      liveBranch: 'master',
      promotePlanned: true,
    });
  });

  it('plans no promotion for a none project whose two branches differ', () => {
    expect(
      releaseBranches({ baseBranch: 'release/stg', liveBranch: 'release/production' }, 'none'),
    ).toEqual({
      baseBranch: 'release/stg',
      liveBranch: 'release/stg',
      promotePlanned: false,
    });
  });

  it('plans no promotion for a publish project', () => {
    expect(releaseBranches({ baseBranch: 'main', liveBranch: 'main' }, 'publish')).toEqual({
      baseBranch: 'main',
      liveBranch: 'main',
      promotePlanned: false,
    });
  });

  it('a promote project with no live branch releases from its base and plans no promotion', () => {
    expect(releaseBranches({ baseBranch: 'main', liveBranch: null }, 'promote')).toEqual({
      baseBranch: 'main',
      liveBranch: 'main',
      promotePlanned: false,
    });
    expect(releaseBranches({ baseBranch: 'dev', liveBranch: '  ' }, 'promote').promotePlanned).toBe(
      false,
    );
  });

  // ISS-1276 — it threw `RELEASE_BRANCHES_UNDECLARED` here, which refused the release on behalf of
  // a merge step Forge no longer writes. `null` is the reading, and it is never `main`: guessing
  // the branch is what the blocker was standing in the way of.
  it('answers null for an undeclared base branch rather than throwing or guessing main', () => {
    expect(releaseBranches({ baseBranch: null, liveBranch: 'master' }, 'promote')).toEqual({
      baseBranch: null,
      liveBranch: 'master',
      promotePlanned: true,
    });
    expect(releaseBranches({ baseBranch: '', liveBranch: null }, 'none')).toEqual({
      baseBranch: null,
      liveBranch: null,
      promotePlanned: false,
    });
  });

  it('answers null on both branches for a promote project that declares neither', () => {
    expect(releaseBranches({ baseBranch: null, liveBranch: null }, 'promote')).toEqual({
      baseBranch: null,
      liveBranch: null,
      promotePlanned: false,
    });
  });
});
