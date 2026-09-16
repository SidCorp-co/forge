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

  it('reads the scp-style form for any username, not only `git`', () => {
    const other = DEPENDABOT.replace(
      'hono@4.13.5:\n    resolution: {integrity: sha512-deadbeef}',
      'private-pkg@1.0.0:\n    resolution: {repo: deploy@git.example.com:team/private-pkg.git, type: git}',
    );
    const { offenders } = sshResolutions(other);
    expect(offenders.map((o) => o.owner)).toContain('private-pkg@1.0.0');
  });

  it('reads the scp-style form on an unqualified internal host', () => {
    const internal = DEPENDABOT.replace(
      'hono@4.13.5:\n    resolution: {integrity: sha512-deadbeef}',
      'private-pkg@1.0.0:\n    resolution: {repo: deploy@gitlab:team/private-pkg.git, type: git}',
    );
    expect(sshResolutions(internal).offenders.map((o) => o.owner)).toContain('private-pkg@1.0.0');
  });

  it('reads a `name@scheme://host/path` row as the URL it is, not as a host called `https`', () => {
    const urlKeyed = `packages:

  forge-plugin@https://codeload.github.com/SidCorp-co/forge-plugin/tar.gz/${SHA}:
    resolution: {tarball: https://codeload.github.com/SidCorp-co/forge-plugin/tar.gz/${SHA}}

  private@https://user@registry.example.com:8080/x/y.tgz:
    resolution: {tarball: https://user@registry.example.com:8080/x/y.tgz}
`;
    expect(sshResolutions(urlKeyed)).toEqual({ scanned: 2, offenders: [] });
  });

  it('reads a bracketed IPv6 literal as the host it is', () => {
    const v6 = DEPENDABOT.replace(
      'hono@4.13.5:\n    resolution: {integrity: sha512-deadbeef}',
      'private-pkg@1.0.0:\n    resolution: {repo: git@[2001:db8::1]:team/private-pkg.git, type: git}',
    );
    expect(sshResolutions(v6).offenders.map((o) => o.owner)).toContain('private-pkg@1.0.0');
  });

  it('accuses no trailing comment, while the `#<sha>` a git resolution ends on still counts', () => {
    const commented = `packages:

  hono@4.13.5:
    resolution: {integrity: sha512-deadbeef} # replaced ssh://git@host:team/pkg.git with the tarball

  forge-plugin@git+https://git@github.com:SidCorp-co/forge-plugin.git#${SHA}:
    resolution: {commit: ${SHA}, repo: git@github.com:SidCorp-co/forge-plugin.git, type: git}
`;
    const { scanned, offenders } = sshResolutions(commented);
    expect(scanned).toBe(2);
    expect(offenders.map((o) => o.line)).toEqual([6, 7]);
  });

  it('reads a numeric first path segment in a `repo:` field, where no port can be meant', () => {
    const numeric = DEPENDABOT.replace(
      'hono@4.13.5:\n    resolution: {integrity: sha512-deadbeef}',
      'private-pkg@1.0.0:\n    resolution: {repo: git@host:1234/team.git, type: git}',
    );
    expect(sshResolutions(numeric).offenders.map((o) => o.owner)).toContain('private-pkg@1.0.0');
  });

  it('reads a `repo:` remote whose path carries no slash at all', () => {
    const flat = DEPENDABOT.replace(
      'hono@4.13.5:\n    resolution: {integrity: sha512-deadbeef}',
      'private-pkg@1.0.0:\n    resolution: {repo: deploy@gitlab:private-pkg.git, type: git}',
    );
    expect(sshResolutions(flat).offenders.map((o) => o.owner)).toContain('private-pkg@1.0.0');
  });

  it('reads an IPv6 literal carrying an embedded IPv4 tail', () => {
    const mapped = DEPENDABOT.replace(
      'hono@4.13.5:\n    resolution: {integrity: sha512-deadbeef}',
      'private-pkg@1.0.0:\n    resolution: {repo: git@[::ffff:192.0.2.1]:team/private-pkg.git, type: git}',
    );
    expect(sshResolutions(mapped).offenders.map((o) => o.owner)).toContain('private-pkg@1.0.0');
  });

  it('names the package on a key line carrying its own trailing comment', () => {
    const commentedKey = `packages:

  private-pkg@1.0.0: # private dependency
    resolution: {repo: git@gitlab.example.com:team/private-pkg.git, type: git}
`;
    expect(sshResolutions(commentedKey).offenders.map((o) => o.owner)).toEqual([
      'private-pkg@1.0.0',
    ]);
  });

  it('reads a port as a port outside a `repo:` field, so a registry URL still installs', () => {
    const registry = `packages:

  private@1.0.0:
    resolution: {tarball: https://user@host:8080/path/private-1.0.0.tgz}
`;
    expect(sshResolutions(registry)).toEqual({ scanned: 1, offenders: [] });
  });

  it('reads no host and no path in a `name@version:` key line, which every lockfile is full of', () => {
    const versions = `packages:

  '@babel/core@7.28.0':
    resolution: {integrity: sha512-deadbeef}

  vitest@5.0.0(@types/node@22.19.1)(jsdom@28.0.1):
    resolution: {integrity: sha512-cafebabe}

  pkg@1.0.0-alpha.3:
    resolution: {integrity: sha512-f00dface}
`;
    expect(sshResolutions(versions)).toEqual({ scanned: 3, offenders: [] });
  });

  it('accuses no comment, so a lockfile quoting the old SSH remote still installs', () => {
    const commented = SHIPPED.replace(
      'packages:',
      `# replaced git@github.com:SidCorp-co/forge-plugin.git with the codeload tarball\npackages:`,
    );
    expect(sshResolutions(commented).offenders).toEqual([]);
  });

  it('counts zero resolutions in a text that is not a lockfile, so the caller can refuse it', () => {
    expect(sshResolutions('# Changelog\n\nnothing here at all\n')).toEqual({
      scanned: 0,
      offenders: [],
    });
  });
});
