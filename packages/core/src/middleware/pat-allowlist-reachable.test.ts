/**
 * ISS-894 — an allowlisted prefix that no PAT can actually reach is not a
 * harmless spare entry. `/api/agent-sessions` sat on the list until
 * 2026-09-01, inert because `requireUserOrDevice` has no PAT branch, and the
 * route it pre-approved is the cross-project one: `GET /api/agent-sessions`
 * with no `projectId` returns every session of every visible project with
 * `messages[]` attached. Whoever added a PAT branch to that middleware — the
 * next step of the device-token unification — would have shipped that fan-out
 * without ever editing the allowlist.
 *
 * So the rule is not "keep the list tidy": every prefix on it must be reachable
 * TODAY, which forces the grant to be made by someone looking at the route.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../config/env.js', () => ({
  env: { NODE_ENV: 'test', JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef' },
}));
vi.mock('../db/client.js', () => ({ db: {} }));

const { PAT_ALLOWED_PREFIXES } = await import('./pat-rest-surface.js');

const PAT_CAPABLE = ['requireAuth()', 'requireAnyAuth()'];

function routersMountedAt(prefix: string): string[] {
  const index = readFileSync('src/index.ts', 'utf8');
  const mounts = [...index.matchAll(/app\.route\(\s*'([^']+)',\s*(\w+)\s*\)/g)];
  return mounts.flatMap(([, at, router]) => (at === prefix && router ? [router] : []));
}

function fileDefining(symbol: string): string {
  const out = execFileSync('grep', ['-rl', `export const ${symbol}`, 'src', '--include=*.ts'], {
    encoding: 'utf8',
  }).trim();
  const first = out.split('\n')[0] ?? '';
  expect(first, `no file defines ${symbol}`).toBeTruthy();
  return first;
}

describe('every PAT-allowlisted prefix is reachable by a PAT', () => {
  it.each([...PAT_ALLOWED_PREFIXES])('%s is guarded by a PAT-capable middleware', (prefix) => {
    const routers = routersMountedAt(prefix);
    expect(routers, `${prefix} is on the allowlist but nothing mounts there`).not.toHaveLength(0);

    const capable = routers.filter((router) => {
      const source = readFileSync(fileDefining(router), 'utf8');
      return PAT_CAPABLE.some((mw) => source.includes(mw));
    });

    expect(
      capable,
      `${prefix} is allowlisted but every router there (${routers.join(', ')}) rejects a PAT — ` +
        'the entry grants nothing today and pre-approves whatever a future PAT branch exposes',
    ).not.toHaveLength(0);
  });
});

/**
 * The inverse rule, for the prefixes whose absence is a decision rather than
 * an oversight. Reachability alone does not protect them: every one WOULD be
 * reachable the moment someone added it, which is exactly why they are named.
 */
describe('the prefixes that must stay off the list', () => {
  it.each(['/api/agent-sessions', '/api/uploads', '/api/admin', '/api/pat'])(
    '%s is not allowlisted',
    (prefix) => {
      expect(PAT_ALLOWED_PREFIXES).not.toContain(prefix);
    },
  );
});
