import { describe, expect, it } from 'vitest';
import {
  defaultReleaseProcedure,
  ReleaseBranchesUndeclaredError,
  releaseBranches,
} from './plan.js';

describe('releaseBranches', () => {
  // cm:guard this is the row that cut three aborted batches on 2026-09-03: the old loader answered `main → main` for it
  it('promotes staging → master for a project that declares promote', () => {
    expect(releaseBranches({ baseBranch: 'staging', liveBranch: 'master' }, 'promote')).toEqual({
      baseBranch: 'staging',
      liveBranch: 'master',
      promotePlanned: true,
    });
  });

  // cm:guard the MODEL decides, not the branch pair. adminhub-api, adminhub-ui, epodsystem-core,
  // house-supabase, sidboss and sidcorp-mail each carry two genuinely different branches and declare
  // `none`; the comparison this replaced planned a promotion for all six, which is the same wrong
  // inference `release-batch/gate.ts` dropped, one layer down.
  it('plans no promotion for a none project whose two branches differ', () => {
    expect(
      releaseBranches({ baseBranch: 'release/stg', liveBranch: 'release/production' }, 'none'),
    ).toEqual({
      baseBranch: 'release/stg',
      liveBranch: 'release/stg',
      promotePlanned: false,
    });
  });

  // cm:guard a publish project moves no ref: pixelight's release is a theme publish, and telling it
  // to merge main into main is a step that does nothing and reads like a step that does something.
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
    expect(
      releaseBranches({ baseBranch: 'dev', liveBranch: '  ' }, 'promote').promotePlanned,
    ).toBe(false);
  });

  it('an undeclared base branch is an error, never main', () => {
    expect(() => releaseBranches({ baseBranch: null, liveBranch: 'master' }, 'promote')).toThrow(
      ReleaseBranchesUndeclaredError,
    );
    expect(() => releaseBranches({ baseBranch: '', liveBranch: null }, 'none')).toThrow(
      ReleaseBranchesUndeclaredError,
    );
  });
});

describe('defaultReleaseProcedure', () => {
  // cm:guard the merge step is `gate.ts`'s old branch comparison rewritten as prose for an agent.
  // Leaving it unconditional is how the retired model survives a schema change: 28 of 32 fleet
  // projects would still be told to promote a branch nobody promotes.
  it('renders the merge step under promote', () => {
    expect(defaultReleaseProcedure('promote')).toMatch(/1\. Merge baseBranch → liveBranch/);
  });

  it('renders no merge step under publish', () => {
    const text = defaultReleaseProcedure('publish');
    expect(text).not.toMatch(/Merge baseBranch/);
    expect(text).not.toMatch(/liveBranch/);
  });

  it('renders no merge step under none', () => {
    expect(defaultReleaseProcedure('none')).not.toMatch(/Merge baseBranch/);
  });

  // cm:guard the steps renumber rather than starting at 2: an agent told "2. deploy" with no step 1
  // reads a procedure with something missing and goes looking for it.
  it('numbers from 1 whichever model it renders', () => {
    for (const model of ['none', 'promote', 'publish'] as const) {
      expect(defaultReleaseProcedure(model)).toMatch(/^1\./);
    }
  });
});
