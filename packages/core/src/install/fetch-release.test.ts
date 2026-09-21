import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmpVersion, pickLatestRunnerTag, run, tagToVersion } from './fetch-release.js';

const HEAD = 'fbe6468ddf0a1b2c3d4e5f60718293a4b5c6d7e8';

const release = (tag: string, assets: string[]) => ({
  tag_name: tag,
  draft: false,
  prerelease: false,
  assets: assets.map((name) => ({
    name,
    browser_download_url: `https://example.invalid/${tag}/${name}`,
  })),
});

let dir: string;

/** Answers the releases list once, then each asset by the name in its URL. */
function serve(releases: unknown[], bodies: Record<string, string>) {
  return vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url.includes('api.github.com')) {
      return new Response(JSON.stringify(releases), { status: 200 });
    }
    const name = url.split('/').pop() as string;
    if (!(name in bodies)) return new Response('missing', { status: 404 });
    return new Response(bodies[name], { status: 200 });
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fetch-release-'));
  vi.stubEnv('RUNNER_RELEASE_DIR', dir);
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe('fetch-release — the commit a release was built from', () => {
  it('writes the COMMIT the release published beside VERSION', async () => {
    vi.stubGlobal(
      'fetch',
      serve([release('runner-v0.17.1', ['forge-runner-x86_64-unknown-linux-gnu', 'COMMIT'])], {
        'forge-runner-x86_64-unknown-linux-gnu': 'ELF',
        COMMIT: `${HEAD}\n`,
      }),
    );
    await run();
    expect(readFileSync(join(dir, 'VERSION'), 'utf8').trim()).toBe('0.17.1');
    expect(readFileSync(join(dir, 'COMMIT'), 'utf8').trim()).toBe(HEAD);
  });

  it('leaves no COMMIT where the release published none', async () => {
    vi.stubGlobal(
      'fetch',
      serve([release('runner-v0.17.1', ['forge-runner-x86_64-unknown-linux-gnu'])], {
        'forge-runner-x86_64-unknown-linux-gnu': 'ELF',
      }),
    );
    await run();
    expect(existsSync(join(dir, 'COMMIT'))).toBe(false);
  });

  it('removes the previous release COMMIT rather than letting it outlive its release', async () => {
    // A stale commit beside a fresh version is an identity that belongs to
    // neither, and every box would then be compared against a commit nothing
    // shipped (ISS-1165).
    writeFileSync(join(dir, 'COMMIT'), 'bd2e36d5ea1b2c3d4e5f60718293a4b5c6d7e8f9\n');
    writeFileSync(join(dir, 'VERSION'), '0.17.0\n');
    vi.stubGlobal(
      'fetch',
      serve([release('runner-v0.17.1', ['forge-runner-x86_64-unknown-linux-gnu'])], {
        'forge-runner-x86_64-unknown-linux-gnu': 'ELF',
      }),
    );
    await run();
    expect(existsSync(join(dir, 'COMMIT'))).toBe(false);
  });
});

describe('fetch-release — which release it takes', () => {
  it('takes the highest runner-v release, ignoring drafts and other tags', () => {
    const picked = pickLatestRunnerTag([
      release('runner-v0.17.1', []),
      release('v9.9.9', []),
      { ...release('runner-v0.18.0', []), draft: true },
      release('runner-v0.16.0', []),
    ]);
    expect(picked?.tag_name).toBe('runner-v0.17.1');
  });

  it('answers null where nothing qualifies', () => {
    expect(pickLatestRunnerTag([release('v1.0.0', [])])).toBeNull();
  });

  it('strips the tag prefix to a bare version', () => {
    expect(tagToVersion('runner-v0.17.1')).toBe('0.17.1');
    expect(tagToVersion('0.17.1')).toBe('0.17.1');
  });

  it('orders versions by number and not by string', () => {
    expect(cmpVersion('0.17.10', '0.17.9')).toBeGreaterThan(0);
    expect(cmpVersion('0.17.1', '0.17.1')).toBe(0);
  });
});
