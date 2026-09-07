/**
 * An agent cannot sign in, at every entrance there is (ISS-932).
 *
 * Two halves, and both are needed. The behavioural half proves the refusal
 * fires; the structural half scans the tree for callers of `signUserToken` and
 * fails on one that does not refuse first — because the failure mode this
 * guards is not a broken entrance, it is a FOURTH entrance added later by
 * somebody who never read this file.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { agentCannotLogin, assertNotAgent } from './agent-account.js';

const SRC = join(import.meta.dirname, '..');

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      sourceFiles(full, out);
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

describe('assertNotAgent', () => {
  it('throws AGENT_CANNOT_LOGIN for an agent, naming the remedy', () => {
    let thrown: unknown;
    try {
      assertNotAgent('agent', 'user-1');
    } catch (err) {
      thrown = err;
    }
    expect((thrown as { status: number }).status).toBe(403);
    expect((thrown as { cause: { code: string } }).cause.code).toBe('AGENT_CANNOT_LOGIN');
    expect((thrown as { message: string }).message).toMatch(/Agent Access Token/);
  });

  it('lets a human through', () => {
    expect(() => assertNotAgent('human', 'user-1')).not.toThrow();
  });

  // cm:guard the positive form is the assertion. Under `kind !== 'human'` an unrecognised value from a future migration locks every real person out, while the positive form fails open only for a kind that does not exist yet — and the row that must never pass is the one that does.
  it('lets an unknown future kind through rather than locking everyone out', () => {
    expect(() => assertNotAgent('service', 'user-1')).not.toThrow();
    expect(() => assertNotAgent(null, 'user-1')).not.toThrow();
    expect(() => assertNotAgent(undefined, 'user-1')).not.toThrow();
  });

  it('carries the user id so an operator can find the row', () => {
    const err = agentCannotLogin('user-9');
    expect((err.cause as { details: { userId: string } }).details.userId).toBe('user-9');
  });
});

describe('every entrance that mints a user JWT refuses an agent first', () => {
  const callers = sourceFiles(SRC).filter(
    (f) => !f.endsWith('jwt.ts') && /\bsignUserToken\s*\(/.test(readFileSync(f, 'utf8')),
  );

  // cm:guard a caller list that goes EMPTY is a failure, not a pass. The scan is a regex over the tree, so a rename of `signUserToken` would silently match nothing and this whole describe would report three green zeros — the exact shape of a test that cannot fail.
  it('finds the entrances at all', () => {
    expect(callers.length).toBeGreaterThanOrEqual(3);
  });

  it.each([['auth/login.ts'], ['auth/refresh.ts'], ['auth/oauth/handler.ts']])(
    '%s is one of them',
    (rel) => {
      expect(callers.some((f) => f.endsWith(rel))).toBe(true);
    },
  );

  it.each(callers.map((f) => [f.slice(SRC.length + 1), f]))(
    '%s refuses an agent before signing',
    (_rel, full) => {
      const src = readFileSync(full, 'utf8');
      expect(src).toMatch(/assertNotAgent(User)?\s*\(/);
    },
  );
});
