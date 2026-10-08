import { DrizzleQueryError } from 'drizzle-orm/errors';
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

const { classifyError, toolErrorText } = await import('./server.js');

const TOKEN_HASH = 'c3ludGhldGljLXRva2VuLWhhc2gtZm9yLW1jcA';

describe("an MCP tool's error text", () => {
  it('carries the failed statement and none of its bound params', () => {
    const failed = new DrizzleQueryError(
      'update "personal_access_tokens" set "token_hash" = $1 where "id" = $2',
      [TOKEN_HASH, 'pat-1'],
      Object.assign(new Error('deadlock detected'), { code: '40P01' }),
    );
    const { code, message } = classifyError(failed);
    expect(code).toBe('error');
    expect(message).toContain('update "personal_access_tokens"');
    expect(message).not.toContain(TOKEN_HASH);
    expect(message).not.toContain('pat-1');
  });

  it('drops the status word and keeps a refusal code first, as a key refusal reaches the caller', () => {
    expect(toolErrorText('NOT_FOUND: ISSUE_KEY_NOT_HELD: `ISS-9` reads as an issue key')).toBe(
      'Error: ISSUE_KEY_NOT_HELD: `ISS-9` reads as an issue key',
    );
    expect(toolErrorText('BAD_REQUEST: ISSUE_KEY_OUT_OF_RANGE: x')).toBe(
      'Error: ISSUE_KEY_OUT_OF_RANGE: x',
    );
  });

  it('still reads a refusal by its prefix', () => {
    expect(classifyError(new Error('NOT_FOUND: issue ISS-1'))).toEqual({
      code: 'not_found',
      message: 'NOT_FOUND: issue ISS-1',
    });
  });
});
