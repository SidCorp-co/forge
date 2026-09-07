import { describe, expect, it } from 'vitest';
import {
  bornAt,
  isAbandoned,
  reapAbandoned,
  TEMPLATE_PREFIX,
  templateDbName,
  WORKER_PREFIX,
  workerDbName,
} from './scratch-db.js';

const HOUR = 60 * 60 * 1000;

describe('names', () => {
  it('mints a different template for every run', () => {
    const names = new Set(Array.from({ length: 200 }, () => templateDbName()));
    expect(names.size).toBe(200);
  });

  it('mints a different worker database for every run of the same worker', () => {
    expect(workerDbName('3')).not.toBe(workerDbName('3'));
    expect(workerDbName('3').startsWith(`${WORKER_PREFIX}3_`)).toBe(true);
  });

  it('keeps both prefixes, so the reaper can still find them', () => {
    expect(templateDbName().startsWith(TEMPLATE_PREFIX)).toBe(true);
    expect(workerDbName('0').startsWith(WORKER_PREFIX)).toBe(true);
  });

  it('carries the birth time the reaper needs', () => {
    const before = Date.now();
    const born = bornAt(templateDbName());
    expect(born).not.toBeNull();
    expect(born as number).toBeGreaterThanOrEqual(before - 1000);
    expect(born as number).toBeLessThanOrEqual(Date.now() + 1000);
  });

  // cm:guard a name this suite did not mint has NO birth time and must never be reaped. The shared server carries the operator's own databases, and a reaper that dated an unstamped name would be free to drop them.
  it('refuses to date a name it did not mint', () => {
    expect(bornAt('forge')).toBeNull();
    expect(bornAt('forge_test_tpl')).toBeNull();
    expect(bornAt('test_w1')).toBeNull();
    expect(bornAt('postgres')).toBeNull();
  });

  // cm:guard the PREVIOUS name shape is the dangerous one, not an arbitrary string. `test_w29_9ed50deb` satisfies the stamp pattern with `w29` read as base 36 — 41553ms, an instant in 1970 — so without the epoch floor the reaper dates a concurrent run on older code as decades abandoned and drops the database out from under it. That is ISS-937 again, committed by its own fix.
  it('refuses to date the name shape this suite used before', () => {
    expect(bornAt('test_w29_9ed50deb')).toBeNull();
    expect(bornAt('test_w28_2321f868')).toBeNull();
    expect(isAbandoned('test_w29_9ed50deb', Date.now())).toBe(false);
  });
});

describe('isAbandoned', () => {
  it('leaves a database a live run could still own', () => {
    const fresh = templateDbName();
    expect(isAbandoned(fresh, Date.now())).toBe(false);
    expect(isAbandoned(fresh, Date.now() + HOUR)).toBe(false);
  });

  it('claims one no live run can own', () => {
    expect(isAbandoned(templateDbName(), Date.now() + 3 * HOUR)).toBe(true);
  });

  it('never claims a name it cannot date', () => {
    expect(isAbandoned('forge', Date.now() + 1000 * HOUR)).toBe(false);
  });
});

function fakeAdmin(datnames: string[]) {
  const dropped: string[] = [];
  const admin = (async () => datnames.map((datname) => ({ datname }))) as unknown as {
    (...args: unknown[]): Promise<{ datname: string }[]>;
    unsafe: (sql: string) => Promise<unknown>;
  };
  admin.unsafe = async (sql: string) => {
    const m = /DROP DATABASE IF EXISTS "([^"]+)"/.exec(sql);
    if (m?.[1]) dropped.push(m[1]);
    return [];
  };
  return { admin, dropped };
}

describe('reapAbandoned', () => {
  it('drops only what is old and stamped', async () => {
    const now = Date.now();
    const old = `${TEMPLATE_PREFIX}${(now - 3 * HOUR).toString(36)}_aaaaaaaa`;
    const oldWorker = `${WORKER_PREFIX}2_${(now - 3 * HOUR).toString(36)}_bbbbbbbb`;
    const fresh = templateDbName();
    const { admin, dropped } = fakeAdmin([
      old,
      oldWorker,
      fresh,
      'forge',
      'postgres',
      'test_w29_9ed50deb',
    ]);

    // biome-ignore lint/suspicious/noExplicitAny: the fake stands in for a postgres-js tag function
    await expect(reapAbandoned(admin as any, now)).resolves.toEqual([old, oldWorker]);
    expect(dropped).toEqual([old, oldWorker]);
  });

  // cm:guard the reaper survives a drop it is refused. Postgres declines a plain DROP on a database with live sessions, which is the second defence behind the age cutoff, and an exception there would take global setup down with it — turning the safety net into the outage.
  it('keeps going when a drop is refused', async () => {
    const now = Date.now();
    const a = `${TEMPLATE_PREFIX}${(now - 3 * HOUR).toString(36)}_aaaaaaaa`;
    const b = `${TEMPLATE_PREFIX}${(now - 4 * HOUR).toString(36)}_bbbbbbbb`;
    const { admin } = fakeAdmin([a, b]);
    admin.unsafe = async (sql: string) => {
      if (sql.includes(a)) throw new Error('is being accessed by other users');
      return [];
    };

    // biome-ignore lint/suspicious/noExplicitAny: the fake stands in for a postgres-js tag function
    await expect(reapAbandoned(admin as any, now)).resolves.toEqual([b]);
  });
});
