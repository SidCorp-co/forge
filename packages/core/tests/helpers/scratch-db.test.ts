import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  bornAt,
  CASE_PREFIX,
  caseDbName,
  drainRetiredCaseDbs,
  isAbandoned,
  reapAbandoned,
  retireCaseDb,
  runToken,
  sweepRunScratchDbs,
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

  it('refuses to date a name it did not mint', () => {
    expect(bornAt('forge')).toBeNull();
    expect(bornAt('forge_test_tpl')).toBeNull();
    expect(bornAt('test_w1')).toBeNull();
    expect(bornAt('postgres')).toBeNull();
  });

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

describe('a database minted for one test case', () => {
  const token = runToken(templateDbName()) as string;

  it('carries this run\u2019s token, so a sweep can tell it from another run\u2019s', () => {
    expect(caseDbName('iss1046', token).startsWith(`${CASE_PREFIX}${token}_`)).toBe(true);
  });

  it('carries the birth time the reaper needs', () => {
    const born = bornAt(caseDbName('iss1046', token));
    expect(born).not.toBeNull();
    expect(born as number).toBeGreaterThanOrEqual(Date.now() - 1000);
  });

  it('is a different database every time the same file asks for one', () => {
    expect(caseDbName('iss1046', token)).not.toBe(caseDbName('iss1046', token));
  });

  it('stays inside the identifier length Postgres truncates at', () => {
    expect(Buffer.byteLength(caseDbName('conversations', token))).toBeLessThan(63);
  });

  it('refuses a run with no template rather than minting an unsweepable name', () => {
    expect(() => caseDbName('iss1046', null)).toThrow(/TEST_PG_TEMPLATE/);
  });

  it('refuses a tag that would not survive the name', () => {
    expect(() => caseDbName('iss 1046', token)).toThrow(/tag/);
  });

  it('refuses to read a token out of a name this suite did not mint', () => {
    expect(runToken('forge')).toBeNull();
    expect(runToken(undefined)).toBeNull();
  });
});

describe('reapAbandoned, over a case database', () => {
  it('drops one old enough that no live run can own it', async () => {
    const now = Date.now();
    const old = `${CASE_PREFIX}abc_def_iss1046_${(now - 3 * HOUR).toString(36)}_cccccccc`;
    const { admin, dropped } = fakeAdmin([old, 'forge']);

    // biome-ignore lint/suspicious/noExplicitAny: the fake stands in for a postgres-js tag function
    await expect(reapAbandoned(admin as any, now)).resolves.toEqual([old]);
    expect(dropped).toEqual([old]);
  });

  it('leaves one a live run could still be using', async () => {
    const now = Date.now();
    const fresh = caseDbName('iss1046', runToken(templateDbName()) as string);
    const { admin, dropped } = fakeAdmin([fresh]);

    // biome-ignore lint/suspicious/noExplicitAny: the fake stands in for a postgres-js tag function
    await expect(reapAbandoned(admin as any, now)).resolves.toEqual([]);
    expect(dropped).toEqual([]);
  });
});

describe('sweepRunScratchDbs', () => {
  it('drops every case database carrying this run\u2019s token', async () => {
    const mine = runToken(templateDbName()) as string;
    const a = caseDbName('iss1046', mine);
    const b = caseDbName('iss1001', mine);
    const { admin, dropped } = fakeAdmin([a, b, 'forge']);

    // biome-ignore lint/suspicious/noExplicitAny: the fake stands in for a postgres-js tag function
    await expect(sweepRunScratchDbs(admin as any, mine)).resolves.toEqual([a, b]);
    expect(dropped).toEqual([a, b]);
  });

  it('leaves a case database another live run minted', async () => {
    const mine = runToken(templateDbName()) as string;
    const theirs = runToken(templateDbName()) as string;
    const ours = caseDbName('iss1046', mine);
    const { admin, dropped } = fakeAdmin([ours, caseDbName('iss1046', theirs)]);

    // biome-ignore lint/suspicious/noExplicitAny: the fake stands in for a postgres-js tag function
    await expect(sweepRunScratchDbs(admin as any, mine)).resolves.toEqual([ours]);
    expect(dropped).toEqual([ours]);
  });

  it('keeps going when a drop is refused', async () => {
    const mine = runToken(templateDbName()) as string;
    const a = caseDbName('iss1046', mine);
    const b = caseDbName('iss1001', mine);
    const { admin } = fakeAdmin([a, b]);
    admin.unsafe = async (sql: string) => {
      if (sql.includes(a)) throw new Error('is being accessed by other users');
      return [];
    };

    // biome-ignore lint/suspicious/noExplicitAny: the fake stands in for a postgres-js tag function
    await expect(sweepRunScratchDbs(admin as any, mine)).resolves.toEqual([b]);
  });
});

/** A drain connection whose drops settle only when the test says so. */
function heldDrain() {
  const issued: string[] = [];
  const settle: Array<(err?: Error) => void> = [];
  const client = {
    unsafe: (sql: string) =>
      new Promise<unknown>((resolve, reject) => {
        issued.push(sql);
        settle.push((err) => (err ? reject(err) : resolve([])));
      }),
    end: async () => undefined,
  };
  // biome-ignore lint/suspicious/noExplicitAny: the fake stands in for a postgres-js client
  const connect = (() => client) as any;
  return { connect, issued, settle };
}

/** Settle everything the drain has issued and wait for its queue to empty. */
async function settleDrain(h: ReturnType<typeof heldDrain>): Promise<void> {
  for (let i = 0; i < 50; i++) {
    for (const s of h.settle.splice(0)) s();
    if ((await drainRetiredCaseDbs(50)) === 0) return;
  }
  throw new Error('the drain never emptied');
}

describe('the drain', () => {
  it('returns to the case before the drop it queued has settled', async () => {
    const h = heldDrain();
    retireCaseDb('postgres://held/1', 'test_case_held_a', h.connect);
    expect(h.issued).toHaveLength(0);
    await Promise.resolve();
    expect(h.issued).toHaveLength(1);
    await settleDrain(h);
  });

  it('hands the caller back inside the grace while a drop is still in flight', async () => {
    const h = heldDrain();
    retireCaseDb('postgres://held/2', 'test_case_held_b', h.connect);
    retireCaseDb('postgres://held/2', 'test_case_held_c', h.connect);

    const began = Date.now();
    await expect(drainRetiredCaseDbs(30)).resolves.toBe(2);
    expect(Date.now() - began).toBeLessThan(2000);
    await settleDrain(h);
  });

  it('hands what the grace did not reach to the run sweep, and nothing else', async () => {
    const mine = runToken(templateDbName()) as string;
    const a = caseDbName('iss1046', mine);
    const b = caseDbName('iss1001', mine);
    const theirs = caseDbName('iss1046', runToken(templateDbName()) as string);

    const h = heldDrain();
    retireCaseDb('postgres://held/4', a, h.connect);
    retireCaseDb('postgres://held/4', b, h.connect);
    await expect(drainRetiredCaseDbs(30)).resolves.toBe(2);

    const { admin, dropped } = fakeAdmin([a, b, theirs, 'forge']);
    // biome-ignore lint/suspicious/noExplicitAny: the fake stands in for a postgres-js tag function
    await expect(sweepRunScratchDbs(admin as any, mine)).resolves.toEqual([a, b]);
    expect(dropped).toEqual([a, b]);

    await settleDrain(h);
  });

  it('strands nothing behind a drop the server refused', async () => {
    const h = heldDrain();
    retireCaseDb('postgres://held/3', 'test_case_held_d', h.connect);
    retireCaseDb('postgres://held/3', 'test_case_held_e', h.connect);

    await Promise.resolve();
    h.settle.splice(0, 1)[0]?.(new Error('is being accessed by other users'));
    await settleDrain(h);
    expect(h.issued.some((q) => q.includes('test_case_held_e'))).toBe(true);
  });
});

/**
 * The three callers, read rather than run.
 *
 * `retireCaseDb` returns `void`, so the only way a ground can put a drop back on its case's clock
 * is to issue one itself or to call the drain's wait from inside `drop()`. Both are visible in the
 * source, and the source is where they are checked: each ground holds its own admin connection and
 * builds it from the environment, so there is no seam a unit test could hand a held drop through.
 */
const GROUNDS = [
  'release-axes-migration-ground.ts',
  'conversations-migration-ground.ts',
  'mcp-sentinel-migration.fixture.ts',
] as const;

function dropBody(source: string): string {
  const at = source.indexOf('drop: async () => {');
  if (at < 0) throw new Error('no `drop: async () => {` in this ground');
  const end = source.indexOf('\n', source.indexOf('},', at));
  return source.slice(at, end);
}

describe.each(GROUNDS)('%s, giving a case database back', (file) => {
  const source = readFileSync(
    fileURLToPath(new URL(`../integration/${file}`, import.meta.url)),
    'utf8',
  );

  it('hands the name to the drain', () => {
    expect(dropBody(source)).toContain('retireCaseDb(');
  });

  it('issues no drop of its own', () => {
    expect(dropBody(source)).not.toContain('DROP DATABASE');
  });

  it('does not wait the drain out', () => {
    expect(dropBody(source)).not.toContain('drainRetiredCaseDbs');
  });
});
