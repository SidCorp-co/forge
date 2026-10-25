import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { setupTestDatabase } from '../helpers/db.js';
import {
  caseDbName,
  drainRetiredScratchDbs,
  mintRunToken,
  reapAbandoned,
  retireScratchDb,
} from '../helpers/scratch-db.js';
import {
  acquireSharedTemplate,
  formatMarker,
  hashMigrations,
  IDLE_REAP_AFTER_MS,
  parseMarker,
  reapSharedTemplate,
  type SharedTemplate,
  sharedTemplateName,
} from '../helpers/shared-template.js';
import { templateRow, useLockHolders } from '../helpers/shared-template-probe.js';

// The template protocol against the real server: build once under concurrency, reuse by content,
// held while a run lives, reaped only when nobody holds it and nobody has used it for a day.
// Every template here is built from a folder of its own, so no other run's template is touched.
// Reaping and global setup issue a DROP DATABASE inside a case, which a case's budget does not
// cover when the cluster is busy checkpointing (ISS-1141), hence the long timeouts.

const SLOW = 180_000;
const adminUrl = process.env.TEST_PG_ADMIN_URL as string;

let admin: postgres.Sql;
const folders: string[] = [];
const touched = new Set<string>();
const held: SharedTemplate[] = [];

beforeAll(() => {
  admin = postgres(adminUrl, { max: 2, onnotice: () => {} });
});

afterEach(async () => {
  for (const h of held.splice(0)) await h.release();
});

afterAll(async () => {
  for (const name of touched) retireScratchDb(adminUrl, name);
  // Inside the hook's 60s, with room for what follows; what the grace leaves is the sweep's.
  await drainRetiredScratchDbs(45_000);
  await admin.end({ timeout: 5 });
  for (const dir of folders) rmSync(dir, { recursive: true, force: true });
});

function migrations(extra: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'shared-template-e2e-'));
  folders.push(dir);
  mkdirSync(join(dir, 'meta'));
  writeFileSync(
    join(dir, 'meta', '_journal.json'),
    JSON.stringify({ entries: [{ idx: 0, tag: '0000_a' }], salt: extra }),
  );
  writeFileSync(join(dir, '0000_a.sql'), `CREATE TABLE a (x int); -- ${extra}`);
  return dir;
}

function counted() {
  const calls: string[] = [];
  const migrate = async (url: string) => {
    calls.push(url);
    const c = postgres(url, { max: 1, onnotice: () => {} });
    try {
      await c.unsafe('CREATE TABLE a (x int)');
    } finally {
      await c.end({ timeout: 5 });
    }
  };
  return { calls, migrate };
}

async function take(folder: string, migrate: (url: string) => Promise<void>) {
  const got = await acquireSharedTemplate({ adminUrl, migrationsFolder: folder, migrate });
  held.push(got);
  touched.add(got.name);
  return got;
}

const existing = (name: string) => templateRow(admin, name);
const holders = (name: string) => useLockHolders(admin, name);

/** `sql`, with `hook` run right after any query that reads a database's marker, on this or a reserved connection. */
function afterMarkerRead(sql: postgres.Sql, hook: () => Promise<void>): postgres.Sql {
  const wrap = (target: postgres.Sql): postgres.Sql =>
    new Proxy(target, {
      apply: async (fn, self, args) => {
        const out = await Reflect.apply(fn, self, args);
        const text = Array.isArray(args[0]) ? (args[0] as string[]).join('') : '';
        if (text.includes('shobj_description')) await hook();
        return out;
      },
      get: (fn, key, recv) => {
        if (key === 'reserve') return async () => wrap(await fn.reserve());
        return Reflect.get(fn, key, recv);
      },
    });
  return wrap(sql);
}

async function age(name: string, by: number): Promise<void> {
  const marker = parseMarker((await existing(name))?.marker ?? null);
  if (!marker) throw new Error(`${name} has no marker to age`);
  await admin.unsafe(
    `COMMENT ON DATABASE "${name}" IS '${formatMarker({ ...marker, used: marker.used - by })}'`,
  );
}

describe('a template whose content is already on the instance', () => {
  it(
    'is cloned from, with no migration replayed and the same database standing',
    async () => {
      const folder = migrations(`reuse-${mintRunToken()}`);
      const first = counted();
      const second = counted();

      const a = await take(folder, first.migrate);
      const before = await existing(a.name);
      const b = await take(folder, second.migrate);

      expect(a.built).toBe(true);
      expect(b.built).toBe(false);
      expect(b.name).toBe(a.name);
      expect(first.calls).toHaveLength(1);
      expect(second.calls).toHaveLength(0);
      expect((await existing(a.name))?.oid).toBe(before?.oid);
    },
    SLOW,
  );

  it(
    'is cloned into a database that has what the template built',
    async () => {
      const got = await take(migrations(`clone-${mintRunToken()}`), counted().migrate);
      const clone = caseDbName('stplclone');
      await admin.unsafe(`CREATE DATABASE "${clone}" TEMPLATE "${got.name}"`);
      const url = new URL(adminUrl);
      url.pathname = `/${clone}`;
      const c = postgres(url.toString(), { max: 1 });
      try {
        await expect(c`SELECT count(*)::int AS n FROM a`).resolves.toEqual([{ n: 0 }]);
      } finally {
        await c.end({ timeout: 5 });
        retireScratchDb(adminUrl, clone);
      }
    },
    SLOW,
  );
});

describe('a template whose content is not on the instance', () => {
  it(
    'is built under its own name beside the one with other content',
    async () => {
      const salt = mintRunToken();
      const one = counted();
      const other = counted();
      const a = await take(migrations(`one-${salt}`), one.migrate);
      const b = await take(migrations(`two-${salt}`), other.migrate);

      expect(b.name).not.toBe(a.name);
      expect(b.built).toBe(true);
      expect(other.calls).toHaveLength(1);
      expect(await existing(a.name)).toBeDefined();
      expect(await existing(b.name)).toBeDefined();
    },
    SLOW,
  );

  it(
    'is built once between runs that enter together, and every one of them gets it',
    async () => {
      const folder = migrations(`race-${mintRunToken()}`);
      const probe = counted();
      const all = await Promise.all(Array.from({ length: 5 }, () => take(folder, probe.migrate)));

      expect(probe.calls).toHaveLength(1);
      expect(all.filter((t) => t.built)).toHaveLength(1);
      expect(new Set(all.map((t) => t.name)).size).toBe(1);
      expect((await holders(all[0]?.name as string)).length).toBeGreaterThan(0);
    },
    SLOW,
  );

  it(
    'leaves no staging database behind when the build fails, and no template either',
    async () => {
      const folder = migrations(`fail-${mintRunToken()}`);
      const name = sharedTemplateName(hashMigrations(folder));
      touched.add(name);
      const before = await admin<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_database WHERE datname LIKE 'forge\\_test\\_tpl\\_stg\\_%'`;

      await expect(
        acquireSharedTemplate({
          adminUrl,
          migrationsFolder: folder,
          migrate: async () => {
            throw new Error('migration 0001 refused');
          },
        }),
      ).rejects.toThrow(/migration 0001 refused/);

      const after = await admin<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_database WHERE datname LIKE 'forge\\_test\\_tpl\\_stg\\_%'`;
      expect(after[0]?.n).toBeLessThanOrEqual(before[0]?.n as number);
      expect(await existing(name)).toBeUndefined();
    },
    SLOW,
  );
});

describe('a template that is there but was not built by this suite', () => {
  it(
    'is refused by name, and neither rebuilt nor dropped',
    async () => {
      const folder = migrations(`bare-${mintRunToken()}`);
      const name = sharedTemplateName(hashMigrations(folder));
      touched.add(name);
      await admin.unsafe(`CREATE DATABASE "${name}"`);
      const probe = counted();

      await expect(
        acquireSharedTemplate({ adminUrl, migrationsFolder: folder, migrate: probe.migrate }),
      ).rejects.toThrow(new RegExp(`"${name}".*no completeness marker`, 's'));

      expect(probe.calls).toHaveLength(0);
      expect(await existing(name)).toBeDefined();
    },
    SLOW,
  );

  it(
    'is refused when its marker names other content',
    async () => {
      const folder = migrations(`wrong-${mintRunToken()}`);
      const name = sharedTemplateName(hashMigrations(folder));
      touched.add(name);
      await admin.unsafe(`CREATE DATABASE "${name}"`);
      await admin.unsafe(
        `COMMENT ON DATABASE "${name}" IS '${formatMarker({ content: 'abc123', built: 1, used: 1 })}'`,
      );

      await expect(
        acquireSharedTemplate({ adminUrl, migrationsFolder: folder, migrate: counted().migrate }),
      ).rejects.toThrow(/no completeness marker/);
    },
    SLOW,
  );
});

describe('releasing a template', () => {
  it(
    'leaves it standing, whether this run built it or only took it',
    async () => {
      const folder = migrations(`release-${mintRunToken()}`);
      const builder = await take(folder, counted().migrate);
      const user = await take(folder, counted().migrate);
      expect((await holders(builder.name)).length).toBe(2);

      await user.release();
      await builder.release();
      held.length = 0;

      expect(await holders(builder.name)).toEqual([]);
      expect(await existing(builder.name)).toBeDefined();
    },
    SLOW,
  );

  it(
    'stamps the template as used now',
    async () => {
      const got = await take(migrations(`stamp-${mintRunToken()}`), counted().migrate);
      await age(got.name, 5 * 60 * 60 * 1000);
      const aged = parseMarker((await existing(got.name))?.marker ?? null);

      await got.release();
      held.length = 0;

      const stamped = parseMarker((await existing(got.name))?.marker ?? null);
      expect(stamped?.used).toBeGreaterThan(aged?.used as number);
      expect(stamped?.built).toBe(aged?.built);
    },
    SLOW,
  );

  // At 0 the next query on the dead connection is refused; given time the driver has reconnected
  // and the query succeeds on a new backend, which only the pid comparison can tell.
  it.each([0, 500])(
    'says so by name when the lock connection was replaced and %ims passed',
    async (wait) => {
      const got = await take(migrations(`lost-${wait}-${mintRunToken()}`), counted().migrate);
      const [pid] = await holders(got.name);
      await admin`SELECT pg_terminate_backend(${pid as number})`;
      await new Promise((resolve) => setTimeout(resolve, wait));
      const said = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        await got.release();
        held.length = 0;
        expect(said).toHaveBeenCalledWith(expect.stringContaining(`[shared-template] ${got.name}`));
        expect(said).toHaveBeenCalledWith(expect.stringContaining('was replaced'));
      } finally {
        said.mockRestore();
      }
    },
    SLOW,
  );

  it(
    'stays quiet when the connection is the one that took the lock',
    async () => {
      const got = await take(migrations(`quiet-${mintRunToken()}`), counted().migrate);
      const said = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        await got.release();
        held.length = 0;
        expect(said).not.toHaveBeenCalled();
      } finally {
        said.mockRestore();
      }
    },
    SLOW,
  );
});

describe('reapAbandoned, over a shared template', () => {
  const DAY = IDLE_REAP_AFTER_MS;

  it(
    'leaves it alone while a run holds it, however long ago anything last touched it',
    async () => {
      const got = await take(migrations(`held-${mintRunToken()}`), counted().migrate);
      await age(got.name, 3 * DAY);

      const dropped = await reapAbandoned(admin);

      expect(dropped).not.toContain(got.name);
      expect(await existing(got.name)).toBeDefined();
    },
    SLOW,
  );

  it(
    'leaves it alone when nobody holds it but it was used within the day',
    async () => {
      const got = await take(migrations(`recent-${mintRunToken()}`), counted().migrate);
      await got.release();
      held.length = 0;
      await age(got.name, DAY - 60 * 60 * 1000);

      expect(await reapAbandoned(admin)).not.toContain(got.name);
      expect(await existing(got.name)).toBeDefined();
    },
    SLOW,
  );

  it(
    'drops it when nobody holds it and nobody has used it for longer than the day',
    async () => {
      const got = await take(migrations(`idle-${mintRunToken()}`), counted().migrate);
      await got.release();
      held.length = 0;
      await age(got.name, DAY + 60 * 60 * 1000);

      expect(await reapAbandoned(admin)).toContain(got.name);
      expect(await existing(got.name)).toBeUndefined();
    },
    SLOW,
  );

  it(
    'never drops one whose marker names other content, however long ago it was used',
    async () => {
      const name = sharedTemplateName(hashMigrations(migrations(`other-${mintRunToken()}`)));
      touched.add(name);
      await admin.unsafe(`CREATE DATABASE "${name}"`);
      await admin.unsafe(
        `COMMENT ON DATABASE "${name}" IS '${formatMarker({ content: 'abc123', built: 1, used: 1 })}'`,
      );
      const row = await existing(name);

      expect(await reapAbandoned(admin)).not.toContain(name);
      expect((await existing(name))?.oid).toBe(row?.oid);
    },
    SLOW,
  );

  it(
    'reads the marker only once the use lock is its own, so a release that lands in between keeps the template',
    async () => {
      const got = await take(migrations(`between-${mintRunToken()}`), counted().migrate);
      await age(got.name, 3 * DAY);
      const release = () => got.release().then(() => void held.splice(0));

      const dropped = await reapSharedTemplate(afterMarkerRead(admin, release), got.name);

      expect(dropped).toBe(false);
      expect(await existing(got.name)).toBeDefined();
    },
    SLOW,
  );

  it(
    'never drops one it cannot read a marker off',
    async () => {
      const name = sharedTemplateName(hashMigrations(migrations(`unmarked-${mintRunToken()}`)));
      touched.add(name);
      await admin.unsafe(`CREATE DATABASE "${name}"`);

      expect(await reapAbandoned(admin)).not.toContain(name);
      expect(await existing(name)).toBeDefined();
    },
    SLOW,
  );
});

describe('a worker cloning a template that is gone', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env.TEST_PG_TEMPLATE = saved.TEST_PG_TEMPLATE;
  });

  it(
    'fails naming the template, and rebuilds nothing',
    async () => {
      process.env.TEST_PG_TEMPLATE = `forge_test_tpl_${'0'.repeat(24)}`;

      // Declared, so the call clones: a slot database this worker already holds clones nothing.
      await expect(setupTestDatabase({ own: 'clones a template that is gone' })).rejects.toThrow(
        new RegExp(`"${process.env.TEST_PG_TEMPLATE}".*it is gone`, 's'),
      );
      expect(await existing(process.env.TEST_PG_TEMPLATE)).toBeUndefined();
    },
    SLOW,
  );
});
