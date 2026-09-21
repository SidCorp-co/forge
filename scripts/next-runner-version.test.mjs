import { describe, expect, it } from 'vitest';
import { nextRunnerVersion, releasedVersions, workspaceVersion } from './next-runner-version.mjs';

// FIXTURE TEXT — a Cargo manifest this checker parses, not one this repo builds.
const cargo = (version) => `[workspace]
resolver = "2"
members = ["crates/forge-runner-core", "crates/forge-runner"]

[workspace.package]
version = "${version}"
edition = "2021"

[workspace.dependencies]
serde = { version = "1", features = ["derive"] }
`;

describe('next-runner-version — the version the tag carries', () => {
  it('counts one patch past the highest tag on the line the manifest declares', () => {
    expect(
      nextRunnerVersion(cargo('0.17.0'), ['runner-v0.17.0', 'runner-v0.16.0', 'runner-v0.15.0']),
    ).toEqual({ version: '0.17.1', tag: 'runner-v0.17.1' });
  });

  it('counts past the highest patch and not past the last tag listed', () => {
    expect(
      nextRunnerVersion(cargo('0.17.0'), ['runner-v0.17.9', 'runner-v0.17.10', 'runner-v0.17.2'])
        .version,
    ).toBe('0.17.11');
  });

  it('takes the manifest version exactly where no tag carries that line yet', () => {
    expect(nextRunnerVersion(cargo('0.18.0'), ['runner-v0.17.4']).version).toBe('0.18.0');
  });

  it('takes a non-zero patch from the manifest where that line is unreleased', () => {
    expect(nextRunnerVersion(cargo('0.18.3'), ['runner-v0.17.4']).version).toBe('0.18.3');
  });

  it('takes the manifest version where the repository has no tags at all', () => {
    expect(nextRunnerVersion(cargo('0.1.0'), []).version).toBe('0.1.0');
  });

  it('reads past tags that are not runner releases', () => {
    expect(
      nextRunnerVersion(cargo('0.17.0'), ['v1.4.0', 'runner-v0.17.0', 'web-v2.0.0']).version,
    ).toBe('0.17.1');
  });

  it('reads past a runner tag whose version is not three numbers', () => {
    expect(nextRunnerVersion(cargo('0.17.0'), ['runner-v0.17.0', 'runner-vnightly']).version).toBe(
      '0.17.1',
    );
  });
});

describe('next-runner-version — the refusals', () => {
  it('refuses a manifest line below one already released, naming both', () => {
    expect(() => nextRunnerVersion(cargo('0.16.0'), ['runner-v0.17.0'])).toThrow(
      /packages\/runner\/Cargo\.toml declares 0\.16\.0, but runner-v0\.17\.0 is already released/,
    );
  });

  it('refuses a manifest major below one already released', () => {
    expect(() => nextRunnerVersion(cargo('0.99.0'), ['runner-v1.0.0'])).toThrow(
      /runner-v1\.0\.0 is already released/,
    );
  });

  it('names the highest released version it is behind, not the first one it met', () => {
    expect(() =>
      nextRunnerVersion(cargo('0.16.0'), ['runner-v0.17.0', 'runner-v0.19.2', 'runner-v0.18.0']),
    ).toThrow(/runner-v0\.19\.2 is already released/);
  });

  it('refuses a manifest with no workspace version, naming the file', () => {
    expect(() => nextRunnerVersion('[workspace]\nresolver = "2"\n', [])).toThrow(
      /packages\/runner\/Cargo\.toml declares no \[workspace\.package\] version/,
    );
  });

  it('refuses a workspace version that is not three numbers, naming what it read', () => {
    expect(() => nextRunnerVersion(cargo('0.17'), [])).toThrow(
      /declares version "0\.17", which is not <major>\.<minor>\.<patch>/,
    );
  });

  it('does not read the version of a different section as the workspace one', () => {
    const manifest = '[package]\nversion = "9.9.9"\n\n[workspace]\nresolver = "2"\n';
    expect(() => nextRunnerVersion(manifest, [])).toThrow(/declares no \[workspace\.package\]/);
  });
});

describe('next-runner-version — the parts', () => {
  it('reads the workspace version out of the manifest', () => {
    expect(workspaceVersion(cargo('0.17.0'))).toBe('0.17.0');
  });

  it('answers null where the manifest declares none', () => {
    expect(workspaceVersion('[workspace]\n')).toBeNull();
  });

  it('turns runner tags into triples and drops everything else', () => {
    expect(releasedVersions(['runner-v1.2.3', 'v1.2.3', 'runner-vx', 'runner-v0.1.0'])).toEqual([
      [1, 2, 3],
      [0, 1, 0],
    ]);
  });
});
