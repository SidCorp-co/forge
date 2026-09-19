import { describe, expect, it } from 'vitest';
import type { ReleaseChannel } from './channel.js';
import {
  defaultReleaseProcedure,
  ReleaseBranchesUndeclaredError,
  releaseBranches,
} from './plan.js';

// `plan.ts` asks the registry what a provider DECLARES (its release step, its rollback
// representability, its webhook header) rather than naming providers (ISS-1071). Reading an empty
// registry throws rather than answering "no provider declares anything", which is the answer that
// would have made these assertions pass while describing a deployment with no integrations in it.
const { registerAllIntegrations } = await import('../integrations/register-all.js');
registerAllIntegrations();

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

  it('an undeclared base branch is an error, never main', () => {
    expect(() => releaseBranches({ baseBranch: null, liveBranch: 'master' }, 'promote')).toThrow(
      ReleaseBranchesUndeclaredError,
    );
    expect(() => releaseBranches({ baseBranch: '', liveBranch: null }, 'none')).toThrow(
      ReleaseBranchesUndeclaredError,
    );
  });
});

const channel = (over: Partial<ReleaseChannel> = {}): ReleaseChannel => ({
  bindingId: 'b-1',
  provider: 'coolify',
  label: '',
  instructions: null,
  releaseRunnerLabel: null,
  verify: null,
  verifySource: 'none',
  rollback: null,
  ...over,
});

/** A `promote` / `merge-branch` project on one coolify channel — the shape that renders in full. */
const procedure = (over: Partial<Parameters<typeof defaultReleaseProcedure>[0]> = {}): string =>
  defaultReleaseProcedure({
    releaseModel: 'promote',
    releaseStrategy: 'merge-branch',
    channels: [channel()],
    ...over,
  });

describe('defaultReleaseProcedure — the release model', () => {
  it('renders the merge step under promote with merge-branch', () => {
    expect(procedure()).toMatch(/1\. Merge baseBranch → liveBranch/);
  });

  it('renders no merge step under publish', () => {
    const text = procedure({ releaseModel: 'publish', releaseStrategy: null });
    expect(text).not.toMatch(/Merge baseBranch/);
    expect(text).not.toMatch(/liveBranch/);
  });

  it('renders no merge step under none', () => {
    expect(procedure({ releaseModel: 'none', releaseStrategy: null })).not.toMatch(
      /Merge baseBranch/,
    );
  });

  it('numbers from 1 whichever model it renders', () => {
    for (const model of ['none', 'promote', 'publish'] as const) {
      const strategy = model === 'promote' ? ('merge-branch' as const) : null;
      expect(procedure({ releaseModel: model, releaseStrategy: strategy })).toMatch(/^1\./);
    }
  });
});

describe('defaultReleaseProcedure — the declared release strategy', () => {
  for (const strategy of ['cherry-pick', 'tag-mr'] as const) {
    it(`refuses by name under ${strategy} instead of rendering the merge`, () => {
      const text = procedure({ releaseStrategy: strategy });

      expect(text).not.toMatch(/1\. Merge baseBranch → liveBranch and push\./);
      expect(text).toContain(`releaseStrategy: ${strategy}`);
      expect(text).toContain('Forge has no default procedure for it');
      expect(text).toContain('release-procedure');
      expect(text).toMatch(/abort/);
    });
  }

  it('refuses a promote project that declares no strategy at all', () => {
    const text = procedure({ releaseStrategy: null });

    expect(text).not.toMatch(/1\. Merge baseBranch → liveBranch and push\./);
    expect(text).toContain('no releaseStrategy at all');
  });
});

describe('defaultReleaseProcedure — the live channel set', () => {
  it('emits no Coolify instruction for an epodsystem-only publish project', () => {
    const text = procedure({
      releaseModel: 'publish',
      releaseStrategy: null,
      channels: [channel({ provider: 'epodsystem', label: 'aurelle' })],
    });

    // The tool is named ONLY to forbid it. What must not appear is the INSTRUCTION — the call
    // the agent would actually make — so the assertion is on the call form, not on the bare
    // identifier, or the refusal's own "does not reach" sentence would fail its own test.
    expect(text).not.toContain("forge_coolify_deploy { action:'deploy'");
    expect(text).toContain('`forge_coolify_deploy` does not');
    expect(text).toContain('epodsystem [aurelle]');
    expect(text).toContain('NO default deploy step');
  });

  it('refuses a mixed set outright rather than deploying the half it can', () => {
    const text = procedure({
      channels: [channel({ provider: 'coolify' }), channel({ provider: 'epodsystem' })],
    });

    expect(text).not.toContain("forge_coolify_deploy { action:'deploy'");
    expect(text).toContain('NO default deploy step for epodsystem');
    expect(text).toContain('do NOT deploy\n   the other channels first');
  });

  it('names no merge step when the live channel has no default deploy step', () => {
    const text = procedure({
      channels: [channel({ provider: 'epodsystem', label: 'aurelle' })],
    });

    expect(text).not.toMatch(/Merge baseBranch/);
    expect(text).not.toMatch(/^1\./);
    expect(text).not.toContain('CHANGELOG.md');
    expect(text).toMatch(/^STOP —/);
    expect(text).toContain('do NOT merge');
    expect(text).toContain('epodsystem [aurelle]');
  });

  it('renders no deploy or changelog step under a strategy it refuses', () => {
    const text = procedure({ releaseStrategy: 'cherry-pick' });

    expect(text).not.toContain("forge_coolify_deploy { action:'deploy'");
    expect(text).not.toContain('CHANGELOG.md');
    expect(text).not.toMatch(/^1\./);
  });

  it('says there is nothing to deploy when the set is empty', () => {
    const text = procedure({ channels: [] });

    expect(text).not.toContain('forge_coolify_deploy');
    expect(text).toContain('No deploy channel is declared');
  });
});
