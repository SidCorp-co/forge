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
  // cm:guard the merge step is `gate.ts`'s old branch comparison rewritten as prose for an agent.
  // Leaving it unconditional is how the retired model survives a schema change: 28 of 32 fleet
  // projects would still be told to promote a branch nobody promotes.
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

  // cm:guard the steps renumber rather than starting at 2: an agent told "2. deploy" with no step 1
  // reads a procedure with something missing and goes looking for it.
  it('numbers from 1 whichever model it renders', () => {
    for (const model of ['none', 'promote', 'publish'] as const) {
      const strategy = model === 'promote' ? ('merge-branch' as const) : null;
      expect(procedure({ releaseModel: model, releaseStrategy: strategy })).toMatch(/^1\./);
    }
  });
});

describe('defaultReleaseProcedure — the declared release strategy', () => {
  // cm:guard `releaseStrategy` is one of this issue's three declared axes. A default that renders
  // the merge for all three substitutes a whole different release for the one declared — the same
  // silent filling-in the `default('prod')` column did, moved into an instruction an agent acts on.
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
  // cm:guard the Coolify call is emitted only for a coolify channel. butlocs, mowment, pixelight and
  // anhome publish to an epodsystem storefront; `forge_coolify_deploy` does not reach one, so the
  // unconditional line told four fleet projects to release through a tool that cannot see them.
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

  // cm:guard a refusal is the WHOLE procedure or it is not a refusal. This used to render the
  // Coolify deploy FIRST and the epodsystem refusal underneath it, which is an instruction to
  // half-release: one endpoint deployed, the other aborted, and no way back to the state before.
  it('refuses a mixed set outright rather than deploying the half it can', () => {
    const text = procedure({
      channels: [channel({ provider: 'coolify' }), channel({ provider: 'epodsystem' })],
    });

    expect(text).not.toContain("forge_coolify_deploy { action:'deploy'");
    expect(text).toContain('NO default deploy step for epodsystem');
    expect(text).toContain('do NOT deploy\n   the other channels first');
  });

  // cm:guard THE F1 case. `promote` + `merge-branch` + a channel Forge cannot deploy rendered
  // "1. Merge baseBranch → liveBranch and push." and then, below it, the abort. The configuration
  // was unreleasable before the run started and the first thing the run did was move the live
  // branch — the one irreversible instruction in the whole procedure, executed on the way to a stop.
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

  // cm:guard the promote-strategy refusal is the whole body for the same reason: rendered as
  // "1. STOP …" it was followed by "2. Deploy …" and "3. Append to CHANGELOG.md", two executable
  // steps under a line telling the agent to abort.
  it('renders no deploy or changelog step under a strategy it refuses', () => {
    const text = procedure({ releaseStrategy: 'cherry-pick' });

    expect(text).not.toContain("forge_coolify_deploy { action:'deploy'");
    expect(text).not.toContain('CHANGELOG.md');
    expect(text).not.toMatch(/^1\./);
  });

  // cm:guard a project with no channel must be TOLD there is none rather than handed a conditional
  // "if a deploy channel is declared above" it has to evaluate itself.
  it('says there is nothing to deploy when the set is empty', () => {
    const text = procedure({ channels: [] });

    expect(text).not.toContain('forge_coolify_deploy');
    expect(text).toContain('No deploy channel is declared');
  });
});
