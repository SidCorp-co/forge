// `db.execute` is mocked: what these tests own is which report core reads, which
// it refuses and by what name, and that a refusal never reaches the store. The
// statement itself runs against Postgres in `pool-read-report-e2e.test.ts`.

import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const execute = vi.fn(async () => []);
vi.mock('../db/client.js', () => ({ db: { execute } }));

const { heartbeatPool, readHeartbeatPool, readRunnerPoolRead, WIRE_PROJECTS } = await import(
  './pool-read-report.js'
);
const { WIRE_UNITS } = await import('./gate-report.js');

/**
 * The bytes the box puts on the heartbeat, asserted on the producing side by
 * `transport/heartbeat.rs` from a record it planted through its own writer.
 */
const fixture = JSON.parse(
  readFileSync(new URL('./pool-read-report.fixture.json', import.meta.url), 'utf8'),
) as {
  wire: { maxProjects: number; units: number };
  pool: { projects: Array<Record<string, unknown>> };
};

const blind = () => structuredClone(fixture.pool.projects[0]) as Record<string, unknown>;

beforeEach(() => execute.mockClear());

describe('the report a box sends', () => {
  it('reads the fixture the box emits, both projects and both verdicts', () => {
    const read = readHeartbeatPool(fixture.pool);
    expect(read.refused).toBeUndefined();
    expect(read.report?.projects.map((p) => p.verdict)).toEqual(['blind', 'intermittent']);
    expect(read.report?.projects[0]?.lastFailure).toMatchObject({ status: 525 });
  });

  it('declares the bounds the box emits, from the one file both sides read', () => {
    expect(fixture.wire.maxProjects).toBe(WIRE_PROJECTS);
    expect(fixture.wire.units).toBe(WIRE_UNITS);
  });

  it('reads an empty list as the whole picture of a box that failed no read', () => {
    expect(readHeartbeatPool({ projects: [] })).toEqual({ report: { projects: [] } });
  });

  it('reads no key as no report at all', () => {
    expect(readHeartbeatPool(undefined)).toEqual({});
  });
});

describe('what core refuses, by name', () => {
  it('names the path of a verdict it does not know', () => {
    const bad = { ...blind(), verdict: 'catastrophe' };
    expect(readHeartbeatPool({ projects: [bad] }).refused).toMatch(/^pool\.projects\.0\.verdict: /);
  });

  it('refuses a blind project that does not say since when', () => {
    const bad = { ...blind(), unreadSince: null };
    expect(readHeartbeatPool({ projects: [bad] }).refused).toMatch(
      /^pool\.projects\.0\.unreadSince: a blind project names when/,
    );
  });

  it('refuses a blind project with no consecutive failed read', () => {
    const bad = { ...blind(), consecutive: 0 };
    expect(readHeartbeatPool({ projects: [bad] }).refused).toMatch(
      /^pool\.projects\.0\.consecutive: /,
    );
  });

  it('refuses an intermittent project that claims an unreadSince', () => {
    const bad = { ...structuredClone(fixture.pool.projects[1]), unreadSince: 1 };
    expect(readHeartbeatPool({ projects: [bad] }).refused).toMatch(/unreadSince: only a blind/);
  });

  it('refuses a status outside HTTP', () => {
    const bad = blind();
    (bad.lastFailure as Record<string, unknown>).status = 7;
    expect(readHeartbeatPool({ projects: [bad] }).refused).toMatch(/lastFailure\.status/);
  });

  it('refuses a string past the declared width and a list past the declared length', () => {
    const wide = blind();
    (wide.lastFailure as Record<string, unknown>).reason = 'x'.repeat(WIRE_UNITS + 1);
    expect(readHeartbeatPool({ projects: [wide] }).refused).toMatch(/lastFailure\.reason/);
    const many = Array.from({ length: WIRE_PROJECTS + 1 }, () => blind());
    expect(readHeartbeatPool({ projects: many }).refused).toMatch(/^pool\.projects: /);
  });

  it('refuses a key it does not know rather than dropping it', () => {
    expect(readHeartbeatPool({ projects: [], extra: 1 }).refused).toMatch(/^pool: /);
  });
});

describe('the heartbeat half', () => {
  it('stores a readable report and answers that it did', async () => {
    const out = await heartbeatPool(fixture.pool, 'device-1', new Date('2026-09-24T12:00:00Z'));
    expect(out.ack).toEqual({ pool: { accepted: true } });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('stores nothing for a report it cannot read, and says why in the answer', async () => {
    const out = await heartbeatPool({ projects: [{ ...blind(), verdict: 'x' }] }, 'device-1');
    expect(out.ack).toMatchObject({ pool: { accepted: false } });
    expect(String((out.ack.pool as { reason: string }).reason)).toContain('projects.0.verdict');
    expect(execute).not.toHaveBeenCalled();
  });

  it('changes nothing and answers nothing where the box sent no key', async () => {
    const out = await heartbeatPool(undefined, 'device-1');
    expect(out.ack).toEqual({});
    expect(execute).not.toHaveBeenCalled();
  });

  it('answers a store that failed as a refusal instead of failing the heartbeat', async () => {
    execute.mockRejectedValueOnce(new Error('db down'));
    const out = await heartbeatPool(fixture.pool, 'device-1');
    expect(out.ack).toEqual({
      pool: { accepted: false, reason: 'core could not store the pool report' },
    });
  });
});

describe('what a surface reads back', () => {
  it('returns the condition with the time it was heard', () => {
    const stored = { ...blind(), receivedAt: '2026-09-24T12:00:00.000Z' };
    expect(readRunnerPoolRead(stored)).toMatchObject({
      verdict: 'blind',
      receivedAt: '2026-09-24T12:00:00.000Z',
    });
  });

  it('returns null for a runner whose box reported nothing', () => {
    expect(readRunnerPoolRead(null)).toBeNull();
  });
});
