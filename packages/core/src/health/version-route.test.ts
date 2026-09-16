import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../config/env.js', () => ({ env: { PORT: 8080 } }));
vi.mock('../db/client.js', () => ({ db: {}, closeDb: vi.fn(async () => {}) }));

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
