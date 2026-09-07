import { afterEach, describe, expect, it, vi } from 'vitest';

// cm:why `/version` reads no database, but `routes.ts` also mounts the ops-health routes whose authz import pulls the db client and the full env schema — mocked so this route can be requested without a Postgres or a twelve-variable environment.
vi.mock('../config/env.js', () => ({ env: { PORT: 8080 } }));
vi.mock('../db/client.js', () => ({ db: {}, closeDb: vi.fn(async () => {}) }));

// cm:why a fresh module graph per case: `sourceCommit` is a module-load constant, so the build argument has to be in place before the import chain runs, and the shape a build with NO commit answers with is the one thing the integration suite cannot arrange.
const version = async (
  commit: string | undefined,
): Promise<{ version: string; sourceCommit: string | null; uptimeSeconds: number }> => {
  if (commit === undefined) delete process.env.SOURCE_COMMIT;
  else process.env.SOURCE_COMMIT = commit;
  vi.resetModules();
  const { publicHealthRoutes } = await import('./routes.js');
  const res = await publicHealthRoutes.request('/version');
  expect(res.status).toBe(200);
  return (await res.json()) as {
    version: string;
    sourceCommit: string | null;
    uptimeSeconds: number;
  };
};

describe('GET /version', () => {
  afterEach(() => {
    delete process.env.SOURCE_COMMIT;
  });

  it('names the commit the build was made from', async () => {
    const body = await version('3dee4d1f24ed2733f22065ab3f7caf921585a904');
    expect(body.sourceCommit).toBe('3dee4d1f24ed2733f22065ab3f7caf921585a904');
  });

  // cm:guard the key is PRESENT and null, never omitted: `release-gate` condition 4 is answered by reading this field, and a caller cannot tell an omitted key from an older build that serves no such field at all.
  it('answers a present, null sourceCommit when the build was not told', async () => {
    const body = await version(undefined);
    expect(body.sourceCommit).toBeNull();
    expect(Object.keys(body)).toContain('sourceCommit');
  });

  it('reports a value that is not a commit hash as missing rather than serving it', async () => {
    await expect(version('HEAD')).resolves.toMatchObject({ sourceCommit: null });
  });

  it('keeps version and uptimeSeconds meaning what they did', async () => {
    const body = await version('3dee4d1f');
    expect(typeof body.version).toBe('string');
    expect(body.version.length).toBeGreaterThan(0);
    expect(Number.isInteger(body.uptimeSeconds)).toBe(true);
  });
});
