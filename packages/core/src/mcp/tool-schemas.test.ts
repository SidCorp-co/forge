/**
 * `tools/list` builds every tool's input schema at once, so one that cannot be rendered takes
 * the whole listing with it and nothing on the way in says which. `z.toJSONSchema` refuses a
 * transform, so a schema good for parsing can still be unusable here (ISS-1170).
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('../config/env.js', () => ({
  env: {
    JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef',
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://localhost/stub',
    APP_BASE_URL: 'https://forge.test',
    UPLOADS_MAX_BYTES: 1,
    UPLOADS_INLINE_MAX_BYTES: 1,
    FEEDBACK_MAX_PER_JOB: 1,
  },
}));
vi.mock('../db/client.js', () => ({ db: {} }));

const { createMcpServer } = await import('./server.js');

const fakeCtx = { principal: { userId: 'u1' }, deprecations: new Set<string>() } as never;

describe('the MCP tool listing', () => {
  it('builds every tool, so no one schema can take the listing down with it', () => {
    expect(() => createMcpServer(fakeCtx)).not.toThrow();
  });
});
