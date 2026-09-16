import { describe, expect, it } from 'vitest';
import { sshResolutions } from './lockfile-transport.mjs';

const SHA = '2f3f40e245dd79c416f1abdbdd52e6487c632b97';

// The shape Dependabot wrote on PR #394, beside the shape that ships. Both are
// quoted from the two sides of that pull request's `pnpm-lock.yaml` diff.
const DEPENDABOT = `importers:

  packages/core:
    dependencies:
      forge-plugin:
        specifier: github:SidCorp-co/forge-plugin#${SHA}
        version: git+https://git@github.com:SidCorp-co/forge-plugin.git#${SHA}

packages:

  forge-plugin@git+https://git@github.com:SidCorp-co/forge-plugin.git#${SHA}:
    resolution: {commit: ${SHA}, repo: git@github.com:SidCorp-co/forge-plugin.git, type: git}
    version: 3.36.22

  hono@4.13.5:
    resolution: {integrity: sha512-deadbeef}
`;

const SHIPPED = `importers:

  packages/core:
    dependencies:
      forge-plugin:
        specifier: https://codeload.github.com/SidCorp-co/forge-plugin/tar.gz/${SHA}
        version: https://codeload.github.com/SidCorp-co/forge-plugin/tar.gz/${SHA}

packages:

  forge-plugin@https://codeload.github.com/SidCorp-co/forge-plugin/tar.gz/${SHA}:
    resolution: {tarball: https://codeload.github.com/SidCorp-co/forge-plugin/tar.gz/${SHA}}
    version: 3.36.22

  hono@4.13.5:
    resolution: {integrity: sha512-deadbeef}
`;

describe('sshResolutions', () => {
  it('reports the scp-style host that an https-looking scheme hides', () => {
    const { offenders } = sshResolutions(DEPENDABOT);
    expect(offenders.map((o) => o.text)).toEqual([
      `version: git+https://git@github.com:SidCorp-co/forge-plugin.git#${SHA}`,
      `forge-plugin@git+https://git@github.com:SidCorp-co/forge-plugin.git#${SHA}:`,
      `resolution: {commit: ${SHA}, repo: git@github.com:SidCorp-co/forge-plugin.git, type: git}`,
    ]);
  });

  it('names the package and the line each offender was found on', () => {
    const { offenders } = sshResolutions(DEPENDABOT);
    expect(offenders[0]).toMatchObject({ line: 7, owner: 'forge-plugin' });
    expect(offenders[2]).toMatchObject({
      line: 12,
      owner: `forge-plugin@git+https://git@github.com:SidCorp-co/forge-plugin.git#${SHA}`,
    });
  });

  it('reports nothing on the codeload resolution that ships', () => {
    expect(sshResolutions(SHIPPED).offenders).toEqual([]);
  });

  it('counts every resolution it read, on a clean lockfile and a dirty one alike', () => {
    expect(sshResolutions(SHIPPED).scanned).toBe(2);
    expect(sshResolutions(DEPENDABOT).scanned).toBe(2);
  });

  it('reports every offender rather than the first', () => {
    const two = DEPENDABOT.replace(
      'hono@4.13.5:\n    resolution: {integrity: sha512-deadbeef}',
      'other@1.0.0:\n    resolution: {repo: ssh://git@gitlab.example/other.git, type: git}',
    );
    const owners = sshResolutions(two).offenders.map((o) => o.owner);
    expect(owners).toContain('other@1.0.0');
    expect(owners.filter((o) => o.startsWith('forge-plugin'))).toHaveLength(3);
  });

  it('names the package on a `snapshots:` row, not the section heading it sits under', () => {
    const withSnapshots = `${DEPENDABOT}
snapshots:

  forge-plugin@git+https://git@github.com:SidCorp-co/forge-plugin.git#${SHA}: {}
`;
    const last = sshResolutions(withSnapshots).offenders.at(-1);
    expect(last.owner).toBe(
      `forge-plugin@git+https://git@github.com:SidCorp-co/forge-plugin.git#${SHA}`,
    );
  });

  it('counts zero resolutions in a text that is not a lockfile, so the caller can refuse it', () => {
    expect(sshResolutions('# Changelog\n\nnothing here at all\n')).toEqual({
      scanned: 0,
      offenders: [],
    });
  });
});
