// @direct-test-of docker-compose.dev.yml
// @direct-test-of docker-compose.prod.yml
// @direct-test-of packages/core/src/shutdown.ts
//
// ISS-930: the stop grace each compose file gives core exceeds core's own shutdown budget, so a
// stop never kills core while a write it already committed is still answering. Docker's default
// grace is 10 s and core's budget was 30 s; the two drifted apart because nothing held them. And
// the healthcheck reads a draining core unhealthy before core closes its listener, so the proxy
// never routes to a closed one (round 2: forge-dev's rollovers answered 502).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SHUTDOWN_LIMITS } from './shutdown.js';

const COMPOSE_FILES = ['docker-compose.dev.yml', 'docker-compose.prod.yml'];
// Coolify's own grace on a deploy's stop (`docker stop --time`) when the application sets none
const COOLIFY_DEFAULT_STOP_GRACE_MS = 30_000;

// Traefik's `providersThrottleDuration` default: after a Docker event it waits this long before it
// applies the configuration that stops routing to the container
const TRAEFIK_PROVIDERS_THROTTLE_MS = 2_000;

/** The lines of the `core` service, or why there are none. */
function coreBlock(compose: string): string[] | string {
  const lines = compose.split('\n');
  const start = lines.indexOf('  core:');
  if (start < 0) return 'no `core` service at two spaces under `services`';
  const end = lines.findIndex((l, i) => i > start && /^ {0,2}\S/.test(l));
  return lines.slice(start + 1, end < 0 ? undefined : end);
}

/** A compose duration (`40s`, `500ms`, `1m`) in ms, or why it is not one. */
function durationMs(line: string, value: string): number | string {
  const m = /^"?(\d+)(ms|s|m)"?$/.exec(value.trim());
  if (!m) return `\`${line.trim()}\` is not a whole number of ms, s or m`;
  return Number(m[1]) * { ms: 1, s: 1_000, m: 60_000 }[m[2] as 'ms' | 's' | 'm'];
}

/** The `stop_grace_period` of the `core` service, in ms, or why it cannot be read. */
function coreStopGraceMs(compose: string): number | string {
  const block = coreBlock(compose);
  if (typeof block === 'string') return block;
  const line = block.find((l) => /^ {4}stop_grace_period:/.test(l));
  if (!line) return 'the `core` service sets no `stop_grace_period`, so Docker kills it after 10 s';
  return durationMs(line, line.replace(/^ {4}stop_grace_period:/, ''));
}

/**
 * The longest the `core` service's healthcheck takes to read a draining core unhealthy, in ms:
 * the next probe is at most one interval away and `retries` failures in a row are needed, the
 * last of which may run its whole timeout. Or why it cannot be read.
 */
function coreUnhealthyAfterMs(compose: string): number | string {
  const block = coreBlock(compose);
  if (typeof block === 'string') return block;
  const at = block.findIndex((l) => /^ {4}healthcheck:/.test(l));
  if (at < 0) return 'the `core` service has no healthcheck, so the proxy routes to it until it dies';
  const end = block.findIndex((l, i) => i > at && /^ {0,4}\S/.test(l));
  const health = block.slice(at + 1, end < 0 ? undefined : end);
  const field = (key: string) => {
    const line = health.find((l) => new RegExp(`^ {6}${key}:`).test(l));
    if (!line) return `the \`core\` healthcheck sets no \`${key}\``;
    return line.replace(new RegExp(`^ {6}${key}:`), '');
  };
  const interval = field('interval');
  const timeout = field('timeout');
  const retries = field('retries');
  for (const v of [interval, timeout, retries]) if (v.startsWith('the `core`')) return v;
  const intervalMs = durationMs(`interval:${interval}`, interval);
  const timeoutMs = durationMs(`timeout:${timeout}`, timeout);
  if (typeof intervalMs === 'string') return intervalMs;
  if (typeof timeoutMs === 'string') return timeoutMs;
  if (!/^\s*\d+\s*$/.test(retries)) return `\`retries:${retries}\` is not a whole number`;
  return intervalMs * Number(retries) + timeoutMs;
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

  for (const file of COMPOSE_FILES) {
    it(`${file} reads a draining core unhealthy, and the proxy stops routing, before core closes its listener`, () => {
      const unhealthy = coreUnhealthyAfterMs(
        readFileSync(new URL(`../../../${file}`, import.meta.url), 'utf8'),
      );
      expect(unhealthy).toBeTypeOf('number');
      expect((unhealthy as number) + TRAEFIK_PROVIDERS_THROTTLE_MS).toBeLessThanOrEqual(
        SHUTDOWN_LIMITS.deregisterMs,
      );
    });
  }

  it("fits core's budget under Coolify's default deploy grace, and HTTP's drain inside the budget", () => {
    expect(SHUTDOWN_LIMITS.timeoutMs).toBeLessThan(COOLIFY_DEFAULT_STOP_GRACE_MS);
    expect(SHUTDOWN_LIMITS.httpDrainMs).toBeLessThan(SHUTDOWN_LIMITS.timeoutMs);
    expect(SHUTDOWN_LIMITS.deregisterMs).toBeLessThan(SHUTDOWN_LIMITS.timeoutMs);
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
    expect(coreUnhealthyAfterMs('services:\n  core:\n    restart: unless-stopped\n')).toMatch(
      /has no healthcheck/,
    );
    expect(
      coreUnhealthyAfterMs(
        'services:\n  core:\n    healthcheck:\n      interval: 10s\n      timeout: 3s\n    expose:\n      - "8080"\n',
      ),
    ).toMatch(/sets no `retries`/);
    expect(
      coreUnhealthyAfterMs(
        'services:\n  core:\n    healthcheck:\n      interval: 10s\n      timeout: 3s\n      retries: 5\n',
      ),
    ).toBe(53_000);
  });
});
