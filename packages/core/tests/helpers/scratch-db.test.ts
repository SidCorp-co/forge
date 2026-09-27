import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  bornAt,
  CASE_PREFIX,
  caseDbName,
  drainRetiredScratchDbs,
  isAbandoned,
  reapAbandoned,
  retireScratchDb,
  runToken,
  sweepRunScratchDbs,
  TEMPLATE_PREFIX,
  templateDbName,
  WORKER_PREFIX,
  workerDbName,
} from './scratch-db.js';

const HOUR = 60 * 60 * 1000;

const TOKEN = runToken(templateDbName()) as string;

describe('names', () => {
  it('mints a different template for every run', () => {
    const names = new Set(Array.from({ length: 200 }, () => templateDbName()));
    expect(names.size).toBe(200);
  });

  it('mints a different file database for every call of the same worker', () => {
    expect(workerDbName('3', TOKEN)).not.toBe(workerDbName('3', TOKEN));
  });

  it('carries this run\u2019s token, so a sweep can tell a file database from another run\u2019s', () => {
    expect(workerDbName('3', TOKEN).startsWith(`${WORKER_PREFIX}${TOKEN}_3_`)).toBe(true);
  });

  it('refuses a run with no template rather than minting an unsweepable file database', () => {
    expect(() => workerDbName('3', null)).toThrow(/TEST_PG_TEMPLATE/);
  });

  it('keeps both prefixes, so the reaper can still find them', () => {
    expect(templateDbName().startsWith(TEMPLATE_PREFIX)).toBe(true);
    expect(workerDbName('0', TOKEN).startsWith(WORKER_PREFIX)).toBe(true);
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

/** A `pg_database` a drop actually empties, so a sweep that reads the catalog back can terminate. */
function fakeAdmin(datnames: string[]) {
  const catalog = new Set(datnames);
  const dropped: string[] = [];
  const admin = (async () => [...catalog].map((datname) => ({ datname }))) as unknown as {
    (...args: unknown[]): Promise<{ datname: string }[]>;
    unsafe: (sql: string) => Promise<unknown>;
  };
  admin.unsafe = async (sql: string) => {
    const m = /DROP DATABASE IF EXISTS "([^"]+)"/.exec(sql);
    if (m?.[1]) {
      dropped.push(m[1]);
      catalog.delete(m[1]);
    }
    return [];
  };
  return { admin, catalog, dropped };
}

describe('reapAbandoned', () => {
  it('drops only what is old and stamped', async () => {
    const now = Date.now();
    const old = `${TEMPLATE_PREFIX}${(now - 3 * HOUR).toString(36)}_aaaaaaaa`;
    const oldWorker = `${WORKER_PREFIX}abc_2_${(now - 3 * HOUR).toString(36)}_bbbbbbbb`;
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
  it('carries this run\u2019s token, so a sweep can tell it from another run\u2019s', () => {
    expect(caseDbName('iss1046', TOKEN).startsWith(`${CASE_PREFIX}${TOKEN}_`)).toBe(true);
  });

  it('carries the birth time the reaper needs', () => {
    const born = bornAt(caseDbName('iss1046', TOKEN));
    expect(born).not.toBeNull();
    expect(born as number).toBeGreaterThanOrEqual(Date.now() - 1000);
  });

  it('is a different database every time the same file asks for one', () => {
    expect(caseDbName('iss1046', TOKEN)).not.toBe(caseDbName('iss1046', TOKEN));
  });

  it('stays inside the identifier length Postgres truncates at', () => {
    expect(Buffer.byteLength(caseDbName('conversations', TOKEN))).toBeLessThan(63);
    expect(Buffer.byteLength(workerDbName('12', TOKEN))).toBeLessThan(63);
  });

  it('refuses a run with no template rather than minting an unsweepable name', () => {
    expect(() => caseDbName('iss1046', null)).toThrow(/TEST_PG_TEMPLATE/);
  });

  it('refuses a tag that would not survive the name', () => {
    expect(() => caseDbName('iss 1046', TOKEN)).toThrow(/tag/);
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

  it('drops every file database carrying this run\u2019s token', async () => {
    const mine = runToken(templateDbName()) as string;
    const a = workerDbName('1', mine);
    const b = workerDbName('2', mine);
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

  it('leaves a file database another live run minted', async () => {
    const mine = runToken(templateDbName()) as string;
    const theirs = runToken(templateDbName()) as string;
    const ours = workerDbName('1', mine);
    const { admin, dropped } = fakeAdmin([ours, workerDbName('1', theirs)]);

    // biome-ignore lint/suspicious/noExplicitAny: the fake stands in for a postgres-js tag function
    await expect(sweepRunScratchDbs(admin as any, mine)).resolves.toEqual([ours]);
    expect(dropped).toEqual([ours]);
  });

  it('keeps going when a drop is refused', async () => {
    const mine = runToken(templateDbName()) as string;
    const a = caseDbName('iss1046', mine);
    const b = caseDbName('iss1001', mine);
    const { admin, catalog } = fakeAdmin([a, b]);
    const real = admin.unsafe;
    admin.unsafe = async (sql: string) => {
      if (sql.includes(a)) throw new Error('is being accessed by other users');
      return real(sql);
    };

    // biome-ignore lint/suspicious/noExplicitAny: the fake stands in for a postgres-js tag function
    await expect(sweepRunScratchDbs(admin as any, mine)).resolves.toEqual([b]);
    expect(catalog.has(a)).toBe(true);
  });

  it('tries a name again when the first drop of it was refused', async () => {
    const mine = runToken(templateDbName()) as string;
    const a = caseDbName('iss1046', mine);
    const { admin, catalog } = fakeAdmin([a]);
    const real = admin.unsafe;
    let refusals = 0;
    admin.unsafe = async (sql: string) => {
      if (sql.includes(a) && refusals++ < 1) throw new Error('is being dropped');
      return real(sql);
    };

    // biome-ignore lint/suspicious/noExplicitAny: the fake stands in for a postgres-js tag function
    await expect(sweepRunScratchDbs(admin as any, mine)).resolves.toEqual([a]);
    expect(catalog.size).toBe(0);
  });

  it('names a database it could not drop rather than returning as though it had', async () => {
    const mine = runToken(templateDbName()) as string;
    const a = caseDbName('iss1046', mine);
    const { admin } = fakeAdmin([a]);
    admin.unsafe = async () => {
      throw new Error('is being accessed by other users');
    };
    const said: string[] = [];
    const was = console.error;
    console.error = (msg: string) => said.push(msg);

    try {
      // biome-ignore lint/suspicious/noExplicitAny: the fake stands in for a postgres-js tag function
      await expect(sweepRunScratchDbs(admin as any, mine)).resolves.toEqual([]);
    } finally {
      console.error = was;
    }
    expect(said.join('\n')).toContain(a);
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
    if ((await drainRetiredScratchDbs(50)) === 0) return;
  }
  throw new Error('the drain never emptied');
}

describe('the drain', () => {
  it('returns to the caller before the drop it queued has settled', async () => {
    const h = heldDrain();
    retireScratchDb('postgres://held/1', 'test_case_held_a', h.connect);
    expect(h.issued).toHaveLength(0);
    await Promise.resolve();
    expect(h.issued).toHaveLength(1);
    await settleDrain(h);
  });

  it('hands the caller back inside the grace while a drop is still in flight', async () => {
    const h = heldDrain();
    retireScratchDb('postgres://held/2', 'test_case_held_b', h.connect);
    retireScratchDb('postgres://held/2', 'test_case_held_c', h.connect);

    const began = Date.now();
    await expect(drainRetiredScratchDbs(30)).resolves.toBe(2);
    expect(Date.now() - began).toBeLessThan(2000);
    await settleDrain(h);
  });

  it('hands what the grace did not reach to the run sweep, and nothing else', async () => {
    const mine = runToken(templateDbName()) as string;
    const a = caseDbName('iss1046', mine);
    const b = workerDbName('1', mine);
    const theirs = caseDbName('iss1046', runToken(templateDbName()) as string);

    const h = heldDrain();
    retireScratchDb('postgres://held/4', a, h.connect);
    retireScratchDb('postgres://held/4', b, h.connect);
    await expect(drainRetiredScratchDbs(30)).resolves.toBe(2);

    const { admin, dropped } = fakeAdmin([a, b, theirs, 'forge']);
    // biome-ignore lint/suspicious/noExplicitAny: the fake stands in for a postgres-js tag function
    await expect(sweepRunScratchDbs(admin as any, mine)).resolves.toEqual([a, b]);
    expect(dropped).toEqual([a, b]);

    await settleDrain(h);
  });

  it('strands nothing behind a drop the server refused', async () => {
    const h = heldDrain();
    retireScratchDb('postgres://held/3', 'test_case_held_d', h.connect);
    retireScratchDb('postgres://held/3', 'test_case_held_e', h.connect);

    await Promise.resolve();
    h.settle.splice(0, 1)[0]?.(new Error('is being accessed by other users'));
    await settleDrain(h);
    expect(h.issued.some((q) => q.includes('test_case_held_e'))).toBe(true);
  });
});

const TESTS_ROOT = fileURLToPath(new URL('..', import.meta.url));

function sourceOf(rel: string): string {
  return readFileSync(join(TESTS_ROOT, rel), 'utf8');
}

/**
 * The lines of `source` that issue a `DROP DATABASE`, prose about one not counting as one.
 *
 * A comment saying why a teardown no longer waits for a drop is the opposite of the defect, so a
 * plain substring search would read every explanation of this rule as a breach of it.
 */
function dropStatements(source: string): string[] {
  const code = source
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line))
    .join('\n');
  return [...code.matchAll(/\bdrop\s+database\b[^;]*/gi)].map((m) => m[0]);
}

/** The body of `marker`, from its opening brace to the one that closes it. */
function bodyAt(source: string, marker: string, after = ''): string {
  const from = after ? source.indexOf(after) : 0;
  if (from < 0) throw new Error(`no \`${after}\` in this source`);
  const at = source.indexOf(marker, from);
  if (at < 0) throw new Error(`no \`${marker}\` in this source`);
  let depth = 0;
  for (let i = at + marker.length - 1; i < source.length; i++) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(at, i + 1);
    }
  }
  throw new Error(`\`${marker}\` never closes`);
}

/**
 * Every teardown vitest puts a clock on, and the marker its body starts at.
 *
 * `retireScratchDb` returns `void`, so the only way one of these can put a `DROP DATABASE` back
 * inside its own budget is to issue one itself, and that is visible in the source. The source is
 * where it is checked: each of these builds its own admin connection out of the environment and
 * offers no seam a held drop could be handed through.
 */
const BUDGETED_TEARDOWNS: Array<[string, string, string]> = [
  ['integration/release-axes-migration-ground.ts', 'drop: async () => {', ''],
  ['integration/conversations-migration-ground.ts', 'drop: async () => {', ''],
  ['integration/mcp-sentinel-migration.fixture.ts', 'drop: async () => {', ''],
  ['integration/release-axes-migration-ground.ts', 'async stop() {', ''],
  ['integration/conversations-migration-ground.ts', 'async stop() {', ''],
  ['integration/mcp-sentinel-migration.fixture.ts', 'afterAll(async () => {', ''],
  ['helpers/db.ts', 'cleanup: async () => {', 'async function cloneFromTemplate'],
];

describe.each(BUDGETED_TEARDOWNS)('%s, at `%s`', (file, marker, after) => {
  const body = bodyAt(sourceOf(file), marker, after);

  it('hands the name to the drain', () => {
    expect(body).toContain('retireScratchDb(');
  });

  it('issues no drop of its own', () => {
    expect(dropStatements(body)).toEqual([]);
  });
});

describe.each(BUDGETED_TEARDOWNS.slice(0, 3))('%s, giving a case database back', (file, marker) => {
  it('does not wait the drain out, which is a hook\u2019s job and never a case\u2019s', () => {
    expect(bodyAt(sourceOf(file), marker)).not.toContain('drainRetiredScratchDbs');
  });
});

/**
 * The three files a judging run caught were the three it happened to run; the property is the
 * suite's. A `DROP DATABASE` waits on a cluster-wide checkpoint, so any one of them inside a case's
 * 30s or a hook's 60s makes that verdict a fact about what else is running (ISS-1141). These two
 * are the only places one may be awaited: the drain, which no vitest clock covers, and the global
 * teardown, which vitest gives no budget at all.
 */
const MAY_AWAIT_A_DROP = new Set([
  'helpers/scratch-db.ts',
  'helpers/global-setup.ts',
  'helpers/scratch-db.test.ts',
]);

function everyTestSource(): string[] {
  return readdirSync(TESTS_ROOT, { recursive: true, encoding: 'utf8' })
    .map((rel) => rel.split('\\').join('/'))
    .filter((rel) => rel.endsWith('.ts'));
}

describe('DROP DATABASE, over every file in the suite', () => {
  it('reads the suite it is judging', () => {
    expect(everyTestSource().length).toBeGreaterThan(100);
  });

  it('reads the statement and not one spelling of it', () => {
    expect(dropStatements('await admin.unsafe(`drop database if exists "x"`);')).toHaveLength(1);
    expect(dropStatements('await admin.unsafe(`DROP\nDATABASE IF EXISTS "x"`);')).toHaveLength(1);
    expect(dropStatements('  // a comment about DROP DATABASE is not one')).toHaveLength(0);
  });

  it('is issued nowhere a vitest clock can time it', () => {
    const offenders = everyTestSource().filter(
      (rel) => !MAY_AWAIT_A_DROP.has(rel) && dropStatements(sourceOf(rel)).length > 0,
    );
    expect(offenders).toEqual([]);
  });
});
