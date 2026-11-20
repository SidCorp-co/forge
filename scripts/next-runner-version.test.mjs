// @direct-test-of scripts/next-runner-version.mjs
//
// ISS-1358: a push to `dev` touching the runner cuts a dev-channel prerelease. Its number is the
// newest `main` release on Cargo's line with `-dev.<n>` after it, so it can never be a tag `main`
// cuts, and `main`'s own numbering reads past every dev tag as before.

import { describe, expect, it } from 'vitest';
import { nextRunnerVersion, parseChannel } from './next-runner-version.mjs';

const cargo = (version) =>
  `[workspace]\nmembers = []\n\n[workspace.package]\nversion = "${version}"\n`;

describe("main's line is numbered as before, whatever dev tags stand beside it", () => {
  it('counts patches off main tags alone', () => {
    const tags = ['runner-v0.17.142', 'runner-v0.17.143', 'runner-v0.17.143-dev.4'];
    expect(nextRunnerVersion(cargo('0.17.0'), tags)).toEqual({
      version: '0.17.144',
      tag: 'runner-v0.17.144',
      prerelease: false,
    });
  });

  it('a new line starts at the declared patch even with dev tags already on it', () => {
    const tags = ['runner-v0.17.143', 'runner-v0.18.0-dev.1', 'runner-v0.18.0-dev.2'];
    expect(nextRunnerVersion(cargo('0.18.0'), tags, 'main').version).toBe('0.18.0');
  });
});

describe('the dev line', () => {
  it('starts at -dev.1 on the declared patch where main has released nothing on the line', () => {
    const tags = ['runner-v0.17.143'];
    expect(nextRunnerVersion(cargo('0.18.0'), tags, 'dev')).toEqual({
      version: '0.18.0-dev.1',
      tag: 'runner-v0.18.0-dev.1',
      prerelease: true,
    });
  });

  it('counts on from the newest dev tag on the same base', () => {
    const tags = ['runner-v0.18.0-dev.1', 'runner-v0.18.0-dev.9', 'runner-v0.18.0-dev.10'];
    expect(nextRunnerVersion(cargo('0.18.0'), tags, 'dev').version).toBe('0.18.0-dev.11');
  });

  it("moves its base to main's newest release on the line and starts the count again", () => {
    const tags = ['runner-v0.18.0', 'runner-v0.18.1', 'runner-v0.18.0-dev.7'];
    expect(nextRunnerVersion(cargo('0.18.0'), tags, 'dev').version).toBe('0.18.1-dev.1');
  });

  it('never names a tag main can cut', () => {
    const tags = ['runner-v0.18.0', 'runner-v0.18.0-dev.3'];
    const dev = nextRunnerVersion(cargo('0.18.0'), tags, 'dev');
    const main = nextRunnerVersion(cargo('0.18.0'), tags, 'main');
    expect(dev.tag).toBe('runner-v0.18.0-dev.4');
    expect(main.tag).toBe('runner-v0.18.1');
    expect(dev.tag).not.toBe(main.tag);
    expect(dev.version).toMatch(/-dev\.\d+$/);
  });

  it('is refused like main where a released line stands above the declared one', () => {
    expect(() => nextRunnerVersion(cargo('0.17.0'), ['runner-v0.18.0'], 'dev')).toThrow(
      /runner-v0\.18\.0 is already released/,
    );
  });
});

describe('the channel argument', () => {
  it('reads main or dev, main when absent', () => {
    expect(parseChannel([])).toBe('main');
    expect(parseChannel(['--channel', 'main'])).toBe('main');
    expect(parseChannel(['--channel', 'dev'])).toBe('dev');
  });

  it('refuses anything else by name', () => {
    expect(() => parseChannel(['--channel', 'beta'])).toThrow(
      /--channel "beta" is not a runner release channel; it takes main or dev/,
    );
    expect(() => parseChannel(['--channel'])).toThrow(/--channel "" is not/);
  });
});
