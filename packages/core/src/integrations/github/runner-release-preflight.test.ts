/**
 * The readings a runner release takes before it cuts, and the words for each.
 *
 * Every case here is a state the repository has actually been in. The lockfile
 * one is runner-v0.6.2 on 2026-06-25, which burned a version number; the crate
 * one is the perpetual update loop a tag that disagrees with
 * `env!("CARGO_PKG_VERSION")` puts the whole fleet into.
 */

import { describe, expect, it } from 'vitest';
import {
  assetNameForTarget,
  isRunnerReleaseTag,
  judgeCrateVersion,
  judgeLockfileVersion,
  judgePublication,
  lockedCrateVersions,
  RUNNER_RELEASE_TARGETS,
  repositoryTruth,
  tagForVersion,
  versionForTag,
  workspacePackageVersion,
} from './runner-release-preflight.js';

const CARGO_TOML = `[workspace]
resolver = "2"
members = ["crates/forge-runner-core", "crates/forge-runner"]

[workspace.package]
version = "0.13.2"
edition = "2021"

[workspace.dependencies]
serde = { version = "1", features = ["derive"] }
toml = "1.1"
`;

const cargoLock = (version: string) => `version = 4

[[package]]
name = "anyhow"
version = "1.0.99"

[[package]]
name = "forge-runner"
version = "${version}"
dependencies = [
 "anyhow",
]

[[package]]
name = "forge-runner-core"
version = "${version}"
dependencies = [
 "serde",
]
`;

describe('the version a caller may name', () => {
  it('builds the tag from a whole X.Y.Z', () => {
    expect(tagForVersion('0.13.3')).toEqual({ tag: 'runner-v0.13.3' });
    expect(tagForVersion(' 1.0.0 ')).toEqual({ tag: 'runner-v1.0.0' });
  });

  it('refuses a version already wearing a prefix, naming what one looks like', () => {
    const refused = tagForVersion('runner-v0.13.3');
    expect(refused).toHaveProperty('message');
    expect('message' in refused && refused.message).toContain('is not a runner version');
    expect('message' in refused && refused.message).toContain('Forge adds that');
  });

  // cm:guard this is the assertion behind criterion 16's exclusion of a prerelease, and it is about `install/fetch-release.ts` rather than about taste: `cmpVersion` there parses dotted integers, so `0.13.3-rc.1` and `0.13.3` compare EQUAL and the channel serves whichever release it meets first.
  it('refuses a prerelease, naming why the channel cannot order one', () => {
    const refused = tagForVersion('0.13.3-rc.1');
    expect('message' in refused && refused.message).toContain('-rc.N');
    expect('message' in refused && refused.message).toContain('dotted integers');
  });

  it('refuses a two-part version and an empty one', () => {
    expect(tagForVersion('0.13')).toHaveProperty('message');
    expect(tagForVersion('')).toHaveProperty('message');
    expect(tagForVersion('v1.2.3')).toHaveProperty('message');
  });

  it('reads a tag back to its version, and knows one when it sees it', () => {
    expect(versionForTag('runner-v0.13.3')).toBe('0.13.3');
    expect(versionForTag('v0.13.3')).toBe('v0.13.3');
    expect(isRunnerReleaseTag('runner-v0.13.3')).toBe(true);
    expect(isRunnerReleaseTag('main')).toBe(false);
    expect(isRunnerReleaseTag('v0.3.0')).toBe(false);
    expect(isRunnerReleaseTag('runner-v0.13.3-rc.1')).toBe(false);
  });
});

describe('the two Cargo readings', () => {
  it('reads the version under [workspace.package] and not the first one in the file', () => {
    expect(workspacePackageVersion(CARGO_TOML)).toBe('0.13.2');
  });

  // cm:guard the regression this case exists for: a scan without the section state returns the
  // first `version = "…"` in the file, which a key added above `[workspace.package]` makes wrong
  // while every other test still passes.
  it('reads nothing when [workspace.package] carries no version', () => {
    expect(workspacePackageVersion('[workspace]\nresolver = "2"\n')).toBeNull();
    expect(workspacePackageVersion('[package]\nversion = "9.9.9"\n')).toBeNull();
  });

  it('reads every [[package]] block out of a lockfile', () => {
    const locked = lockedCrateVersions(cargoLock('0.13.2'));
    expect(locked['forge-runner']).toBe('0.13.2');
    expect(locked['forge-runner-core']).toBe('0.13.2');
    expect(locked.anyhow).toBe('1.0.99');
  });

  it('passes a manifest that agrees with the tag', () => {
    expect(
      judgeCrateVersion({ version: '0.13.2', commitSha: 'abc1234', cargoToml: CARGO_TOML }),
    ).toBeNull();
  });

  it('refuses a manifest that disagrees, naming both versions and the update loop', () => {
    const refused = judgeCrateVersion({
      version: '0.13.3',
      commitSha: 'abc1234',
      cargoToml: CARGO_TOML,
    });
    expect(refused?.step).toBe('check_crate_version');
    expect(refused?.message).toContain('`0.13.2`');
    expect(refused?.message).toContain('`0.13.3`');
    expect(refused?.message).toContain('perpetual update loop');
  });

  it('refuses a manifest it cannot read a version out of at all', () => {
    const refused = judgeCrateVersion({ version: '0.13.2', commitSha: 'abc1234', cargoToml: '' });
    expect(refused?.step).toBe('check_crate_version');
    expect(refused?.message).toContain('declares no `[workspace.package]` version');
  });

  it('passes a lockfile that records the version for both workspace crates', () => {
    expect(
      judgeLockfileVersion({
        version: '0.13.2',
        commitSha: 'abc1234',
        cargoLock: cargoLock('0.13.2'),
      }),
    ).toBeNull();
  });

  it('refuses a stale lockfile, naming the crate, both versions and --locked', () => {
    const refused = judgeLockfileVersion({
      version: '0.13.3',
      commitSha: 'abc1234',
      cargoLock: cargoLock('0.13.2'),
    });
    expect(refused?.step).toBe('check_lockfile_version');
    expect(refused?.message).toContain('forge-runner is `0.13.2`');
    expect(refused?.message).toContain('forge-runner-core is `0.13.2`');
    expect(refused?.message).toContain('--locked');
    expect(refused?.message).toContain('runner-v0.6.2');
  });

  it('refuses a lockfile that holds no entry for a workspace crate', () => {
    const refused = judgeLockfileVersion({
      version: '0.13.2',
      commitSha: 'abc1234',
      cargoLock: '[[package]]\nname = "anyhow"\nversion = "1.0.99"\n',
    });
    expect(refused?.message).toContain('forge-runner is `absent`');
  });
});

describe('what GitHub holds for the tag', () => {
  const whole = {
    htmlUrl: 'https://github.com/o/r/releases/tag/runner-v0.13.3',
    draft: false,
    prerelease: false,
    assetNames: [...RUNNER_RELEASE_TARGETS.map(assetNameForTarget), 'VERSION'],
  };

  it('is published only when every target the workflow builds is on it', () => {
    const judged = judgePublication(whole);
    expect(judged.publication).toBe('published');
    expect(judged.detail).toContain('forge-runner-x86_64-unknown-linux-gnu');
  });

  it('is absent when GitHub holds no release at all', () => {
    expect(judgePublication(null)).toEqual({
      publication: 'absent',
      detail: 'GitHub holds no release for this tag.',
    });
  });

  it('is incomplete when a target is missing, naming what is there and what is not', () => {
    const judged = judgePublication({
      ...whole,
      assetNames: ['forge-runner-aarch64-apple-darwin'],
    });
    expect(judged.publication).toBe('incomplete');
    expect(judged.detail).toContain('missing forge-runner-x86_64-unknown-linux-gnu');
    expect(judged.detail).toContain('Present: forge-runner-aarch64-apple-darwin');
  });

  // cm:guard a draft and a prerelease are `incomplete` however many assets they carry, because `pickLatestRunnerTag` in `install/fetch-release.ts` drops both outright — a release nothing will ever ingest is not a published one.
  it('is incomplete for a draft and for a prerelease, naming the channel that skips them', () => {
    expect(judgePublication({ ...whole, draft: true }).detail).toContain(
      'it is a draft, which the install channel skips',
    );
    expect(judgePublication({ ...whole, prerelease: true }).detail).toContain(
      'it is a prerelease, which the install channel skips',
    );
    expect(judgePublication({ ...whole, draft: true }).publication).toBe('incomplete');
  });

  it('names every fault at once rather than the first', () => {
    const judged = judgePublication({ ...whole, draft: true, assetNames: [] });
    expect(judged.detail).toContain('it is a draft');
    expect(judged.detail).toContain('it is missing');
    expect(judged.detail).toContain('none of the expected assets');
  });
});

describe('what is now true on the repository', () => {
  // cm:guard two commits on the fixture, deliberately different: `commitSha` is what this release ASKED for and `tagCommitSha` is what the tag was READ at. A fixture where they are equal cannot tell a sentence that names the right one from a sentence that names either.
  const base = {
    tag: 'runner-v0.13.3',
    commitSha: 'abc1234',
    tagCommitSha: 'olderco',
    publicationDetail: null,
  };

  it('says nothing was written when the tag is absent', () => {
    const said = repositoryTruth({ ...base, tagState: 'absent', publication: 'unread' });
    expect(said).toContain('Nothing was written to the repository');
    expect(said).toContain('does not exist');
    expect(said).not.toContain('immutable');
  });

  // cm:guard `unread` and `absent` are one fact about Forge and two about the repository. Both say nothing was written; only `absent` may say the tag is not there, because only `absent` came from a lookup GitHub answered. Saying "does not exist" off a lookup that failed is a claim about a repository Forge did not read, and it is the sentence an operator acts on before cutting anything else.
  it('separates a tag nobody read from one read and found missing', () => {
    const said = repositoryTruth({ ...base, tagState: 'unread', publication: 'unread' });
    expect(said).toContain('Nothing was written to the repository');
    expect(said).toContain('did not read whether the tag');
    expect(said).toContain('unread rather than ruled out');
    expect(said).not.toContain('does not exist');
  });

  // cm:guard this sentence is the whole of ISS-1075 point 3 for the shape nobody else reports: a process that died between asking for the tag and hearing the answer. It has to say the tag MAY exist, and it has to say Forge will not tidy it away.
  it('says the tag may or may not exist after a cut whose answer never came', () => {
    const said = repositoryTruth({ ...base, tagState: 'unknown', publication: 'unread' });
    // cm:guard `unknown` is about the create Forge SENT, so it names the commit Forge asked for and not a tag target nobody read.
    expect(said).toContain('at abc1234');
    expect(said).toContain('never heard the answer');
    expect(said).toContain('may or may not exist');
    expect(said).toContain('deletes none and re-cuts none');
  });

  it('says the tag exists and nothing is published when the release is absent', () => {
    const said = repositoryTruth({ ...base, tagState: 'present', publication: 'absent' });
    expect(said).toContain('`runner-v0.13.3` exists at olderco');
    expect(said).not.toContain('at abc1234');
    expect(said).toContain('nothing is published');
    expect(said).toContain('deletes none and re-cuts none');
  });

  it('carries the publication detail through when the release is not whole', () => {
    const said = repositoryTruth({
      ...base,
      tagState: 'present',
      publication: 'incomplete',
      publicationDetail: 'GitHub holds a release for this tag but it is missing forge-runner-x.',
    });
    expect(said).toContain('missing forge-runner-x');
  });

  it('separates a reading nobody could take from one that found nothing', () => {
    const unknown = repositoryTruth({ ...base, tagState: 'present', publication: 'unknown' });
    expect(unknown).toContain('could not read what GitHub holds');
    expect(unknown).toContain('unknown');
    expect(unknown).not.toContain('nothing is published');
  });

  // cm:guard a tag whose target was never read says it exists and stops there. Substituting the requested commit would have the row assert, off no reading at all, that somebody else's tag is at the commit this attempt resolved.
  it('names no commit for a tag nobody read the target of', () => {
    const said = repositoryTruth({
      ...base,
      tagCommitSha: null,
      tagState: 'present',
      publication: 'absent',
    });
    expect(said).toContain('The tag `runner-v0.13.3` exists and');
    expect(said).not.toContain('abc1234');
  });

  it('says the release exists when it is published', () => {
    expect(repositoryTruth({ ...base, tagState: 'present', publication: 'published' })).toContain(
      'holds a published release',
    );
  });
});
