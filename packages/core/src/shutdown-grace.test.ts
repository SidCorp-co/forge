// @direct-test-of docker-compose.dev.yml
// @direct-test-of docker-compose.prod.yml
// @direct-test-of packages/core/src/shutdown.ts
//
// ISS-930: the stop grace each compose file gives core exceeds core's own shutdown budget, so a
// stop never kills core while a write it already committed is still answering. Docker's default
// grace is 10 s and core's budget was 30 s; the two drifted apart because nothing held them.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SHUTDOWN_LIMITS } from './shutdown.js';

const COMPOSE_FILES = ['docker-compose.dev.yml', 'docker-compose.prod.yml'];
// Coolify's own grace on a deploy's stop (`docker stop --time`) when the application sets none
const COOLIFY_DEFAULT_STOP_GRACE_MS = 30_000;

/** The `stop_grace_period` of the `core` service, in ms, or why it cannot be read. */
function coreStopGraceMs(compose: string): number | string {
  const lines = compose.split('\n');
  const start = lines.findIndex((l) => l === '  core:');
  if (start < 0) return 'no `core` service at two spaces under `services`';
  const end = lines.findIndex((l, i) => i > start && /^ {0,2}\S/.test(l));
  const block = lines.slice(start + 1, end < 0 ? undefined : end);
  const line = block.find((l) => /^ {4}stop_grace_period:/.test(l));
  if (!line) return 'the `core` service sets no `stop_grace_period`, so Docker kills it after 10 s';
  const m = /^ {4}stop_grace_period:\s*"?(\d+)(ms|s|m)"?\s*$/.exec(line);
  if (!m) return `\`${line.trim()}\` is not a whole number of ms, s or m`;
  return Number(m[1]) * { ms: 1, s: 1_000, m: 60_000 }[m[2] as 'ms' | 's' | 'm'];
}

describe('the stop grace covers core shutdown budget (ISS-930)', () => {
  for (const file of COMPOSE_FILES) {
    it(`${file} gives core a stop grace over its ${SHUTDOWN_LIMITS.timeoutMs} ms budget`, () => {
      const grace = coreStopGraceMs(
        readFileSync(new URL(`../../../${file}`, import.meta.url), 'utf8'),
      );
      expect(grace).toBeTypeOf('number');
      expect(grace as number).toBeGreaterThan(SHUTDOWN_LIMITS.timeoutMs);
    });
  }

  it("fits core's budget under Coolify's default deploy grace, and HTTP's drain inside the budget", () => {
    expect(SHUTDOWN_LIMITS.timeoutMs).toBeLessThan(COOLIFY_DEFAULT_STOP_GRACE_MS);
    expect(SHUTDOWN_LIMITS.httpDrainMs).toBeLessThan(SHUTDOWN_LIMITS.timeoutMs);
  });

  it('refuses a core service with no grace, or one it cannot read, by name', () => {
    expect(coreStopGraceMs('services:\n  core:\n    restart: unless-stopped\n')).toMatch(
      /sets no `stop_grace_period`/,
    );
    expect(coreStopGraceMs('services:\n  core:\n    stop_grace_period: 1h30m\n')).toMatch(
      /is not a whole number/,
    );
    expect(
      coreStopGraceMs(
        'services:\n  postgres:\n    stop_grace_period: 90s\n  core:\n    stop_grace_period: 20s\n',
      ),
    ).toBe(20_000);
  });
});
