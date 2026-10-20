import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
const { isRefusalSentence } = await import('../lib/refusal-sentence.js');

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
      'Error: ISSUE_KEY_NOT_HELD: `ISS-9` reads as an issue key.',
    );
    expect(toolErrorText('BAD_REQUEST: ISSUE_KEY_OUT_OF_RANGE: x')).toBe(
      'Error: ISSUE_KEY_OUT_OF_RANGE: X.',
    );
  });

  it('still reads a refusal by its prefix', () => {
    expect(classifyError(new Error('NOT_FOUND: issue ISS-1'))).toEqual({
      code: 'not_found',
      message: 'NOT_FOUND: issue ISS-1',
    });
  });
});

/**
 * ISS-1421 r14 — every refusal an MCP tool throws reaches its caller through `toolErrorText`. Each
 * one written under `src/mcp` is read off the source and passed through it, and what comes out
 * must be a sentence: no lower-case opening past its codes, a full stop, never "Invalid input".
 */
const MCP_SRC = fileURLToPath(new URL('.', import.meta.url));
const THROWN = /new Error\(\s*(['"`])((?:\\.|(?!\1).)*?)\1/gs;

function writtenRefusals(): { file: string; said: string }[] {
  return readdirSync(MCP_SRC, { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.includes('.fixture.'))
    .flatMap((file) =>
      [...readFileSync(join(MCP_SRC, file), 'utf8').matchAll(THROWN)]
        // A message that opens on a placeholder is worded where it is built, and read there.
        .filter((m) => !(m[2] ?? '').startsWith('${'))
        .map((m) => ({ file, said: (m[2] ?? '').replace(/\$\{[^}]*\}/g, 'X1') })),
    );
}

describe('every refusal an MCP tool writes, as its caller reads it', () => {
  it('is a sentence', () => {
    const written = writtenRefusals();
    expect(written.length).toBeGreaterThan(200);
    const wrong = written
      .map(({ file, said }) => ({
        file,
        read: toolErrorText(classifyError(new Error(said)).message),
      }))
      .filter(({ read }) => !isRefusalSentence(read.replace(/^Error: /, '')))
      .map(({ file, read }) => `${file}: ${read}`);
    expect(wrong, 'each line is a refusal that does not read as a sentence').toEqual([]);
  });
});
