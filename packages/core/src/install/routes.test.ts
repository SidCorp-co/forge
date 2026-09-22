import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// `RELEASE_DIR` is read once when the module loads, so each case sets the env and
// imports a fresh copy rather than sharing one that read a directory that is gone.
let dir: string;

async function load() {
  vi.resetModules();
  return await import('./routes.js');
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'runner-release-'));
  vi.stubEnv('RUNNER_RELEASE_DIR', dir);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

const publish = (version: string, commit?: string) => {
  writeFileSync(join(dir, 'VERSION'), `${version}\n`);
  if (commit !== undefined) writeFileSync(join(dir, 'COMMIT'), `${commit}\n`);
  writeFileSync(join(dir, 'forge-runner-x86_64-unknown-linux-gnu'), 'ELF');
};

describe('getPublishedRunnerBuild', () => {
  it('reads the version and the commit the release published', async () => {
    publish('0.17.1', 'fbe6468ddf0a1b2c3d4e5f60718293a4b5c6d7e8');
    const { getPublishedRunnerBuild } = await load();
    expect(await getPublishedRunnerBuild()).toEqual({
      version: '0.17.1',
      commit: 'fbe6468ddf0a1b2c3d4e5f60718293a4b5c6d7e8',
    });
  });

  it('reads a null commit where the release published none', async () => {
    publish('0.17.1');
    const { getPublishedRunnerBuild } = await load();
    expect(await getPublishedRunnerBuild()).toEqual({ version: '0.17.1', commit: null });
  });

  it('answers null where nothing is published at all', async () => {
    const { getPublishedRunnerBuild } = await load();
    expect(await getPublishedRunnerBuild()).toBeNull();
  });

  it('answers null where the release directory is not configured', async () => {
    vi.stubEnv('RUNNER_RELEASE_DIR', '');
    const { getPublishedRunnerBuild } = await load();
    expect(await getPublishedRunnerBuild()).toBeNull();
  });
});

describe('GET /install/latest.json', () => {
  const fetchManifest = async (routes: { request: (r: Request) => Response | Promise<Response> }) =>
    await routes.request(new Request('https://core.example/install/latest.json'));

  const manifest = async (routes: { request: (r: Request) => Response | Promise<Response> }) =>
    (await (await fetchManifest(routes)).json()) as Record<string, unknown>;

  it('carries the commit the published release was built from', async () => {
    publish('0.17.1', 'fbe6468ddf0a1b2c3d4e5f60718293a4b5c6d7e8');
    const { installRoutes } = await load();
    const body = await manifest(installRoutes);
    expect(body.version).toBe('0.17.1');
    expect(body.commit).toBe('fbe6468ddf0a1b2c3d4e5f60718293a4b5c6d7e8');
  });

  it('omits the commit rather than sending null where the release recorded none', async () => {
    publish('0.17.1');
    const { installRoutes } = await load();
    const body = await manifest(installRoutes);
    expect(body.version).toBe('0.17.1');
    expect('commit' in body).toBe(false);
  });

  it('still carries an asset per target beside the commit', async () => {
    publish('0.17.1', 'fbe6468ddf0a1b2c3d4e5f60718293a4b5c6d7e8');
    const { installRoutes } = await load();
    const body = await manifest(installRoutes);
    const assets = body.assets as Record<string, { sha256: string }>;
    expect(Object.keys(assets)).toEqual(['x86_64-unknown-linux-gnu']);
    expect(assets['x86_64-unknown-linux-gnu']?.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('answers 404 where nothing is published', async () => {
    const { installRoutes } = await load();
    expect((await fetchManifest(installRoutes)).status).toBe(404);
  });
});
