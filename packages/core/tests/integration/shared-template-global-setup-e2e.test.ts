import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { setup as globalSetup, teardown as globalTeardown } from '../helpers/global-setup.js';
import { MIGRATIONS_FOLDER } from '../helpers/migrate.js';
import {
  bornAt,
  drainRetiredScratchDbs,
  retireScratchDb,
  TEMPLATE_PREFIX,
} from '../helpers/scratch-db.js';
import {
  hashMigrations,
  holderName,
  sharedTemplateName,
  stamp,
} from '../helpers/shared-template.js';
import { templateRow, useLockHolders } from '../helpers/shared-template-probe.js';

// The real global setup and teardown against this run's own instance: which mode builds what, and
// what a teardown leaves standing. A DROP DATABASE inside a case is not covered by a case's budget
// when the cluster is busy checkpointing (ISS-1141), hence the long timeout.

const SLOW = 180_000;
const adminUrl = process.env.TEST_PG_ADMIN_URL as string;

let admin: postgres.Sql;
const existing = (name: string) => templateRow(admin, name);
const holders = (name: string, from?: string) => useLockHolders(admin, name, from);

beforeAll(() => {
  admin = postgres(adminUrl, { max: 2, onnotice: () => {} });
});

afterAll(async () => {
  await admin.end({ timeout: 5 });
});

describe('global setup, run for real against this instance', () => {
  const KEYS = [
    'TEST_DATABASE_URL',
    'TEST_TEMPLATE_MODE',
    'CI',
    'TEST_PG_ADMIN_URL',
    'TEST_PG_TEMPLATE',
    'TEST_PG_RUN_TOKEN',
  ] as const;
  const saved: Record<string, string | undefined> = {};
  const project = {
    vitest: { config: { cliOptions: {} } },
    config: { maxWorkers: 1 },
  } as unknown as Parameters<typeof globalSetup>[0];

  beforeAll(() => {
    for (const k of KEYS) saved[k] = process.env[k];
  });

  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  async function runWith(env: {
    mode?: string;
    ci?: string;
  }): Promise<{ name: string; token: string }> {
    process.env.TEST_DATABASE_URL = adminUrl;
    process.env.TEST_TEMPLATE_MODE = env.mode ?? '';
    process.env.CI = env.ci ?? '';
    vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await globalSetup(project);
    } finally {
      vi.restoreAllMocks();
    }
    return {
      name: process.env.TEST_PG_TEMPLATE as string,
      token: process.env.TEST_PG_RUN_TOKEN as string,
    };
  }

  async function scratchOf(token: string): Promise<string[]> {
    const rows = await admin<{ datname: string }[]>`
      SELECT datname FROM pg_database WHERE datname LIKE ${`test\\_%${token}\\_%`}`;
    return rows.map((r) => r.datname);
  }

  it(
    'shares: leaves the template standing at teardown and drops only its own scratch databases',
    async () => {
      const outer = process.env.TEST_PG_RUN_TOKEN as string;
      // Other runs on this instance may hold the same template — a suite started beside this one
      // takes it while this one sets up, planted here — so what is counted is this process's holder.
      const shared = sharedTemplateName(hashMigrations(MIGRATIONS_FOLDER));
      const mineBefore = (await holders(shared, holderName())).length;
      const other = postgres(adminUrl, { max: 1, onnotice: () => {} });
      await other`SELECT pg_advisory_lock_shared(hashtextextended(${`use:${shared}`}, 0))`;
      const first = await runWith({ mode: 'shared' });
      const mine = `test_case_${first.token}_x_${Date.now().toString(36)}_aaaaaaaa`;
      const theirs = `test_case_${outer}_x_${Date.now().toString(36)}_bbbbbbbb`;
      await admin.unsafe(`CREATE DATABASE "${mine}"`);
      await admin.unsafe(`CREATE DATABASE "${theirs}"`);

      expect(first.token).not.toBe(outer);
      expect(first.name).toBe(process.env.TEST_PG_TEMPLATE);
      expect(first.name).toBe(shared);
      expect((await holders(first.name, holderName())).length).toBe(mineBefore + 1);
      await other.end({ timeout: 5 });

      await globalTeardown();

      expect(await existing(first.name)).toBeDefined();
      expect(await existing(mine)).toBeUndefined();
      expect(await existing(theirs)).toBeDefined();
      retireScratchDb(adminUrl, theirs);
      await drainRetiredScratchDbs(60_000);
    },
    SLOW,
  );

  it(
    'builds privately and drops its template at teardown when told to',
    async () => {
      const run = await runWith({ mode: 'fresh' });

      expect(run.name).toBe(`forge_test_tpl_${run.token}`);
      expect(await existing(run.name)).toBeDefined();
      expect(await holders(run.name)).toEqual([]);

      await globalTeardown();

      expect(await existing(run.name)).toBeUndefined();
      expect(await scratchOf(run.token)).toEqual([]);
    },
    SLOW,
  );

  it(
    'builds privately on CI with no variable set',
    async () => {
      const run = await runWith({ ci: 'true' });
      expect(run.name).toBe(`forge_test_tpl_${run.token}`);

      await globalTeardown();

      expect(await existing(run.name)).toBeUndefined();
    },
    SLOW,
  );

  it(
    'refuses a mode it does not know before building anything',
    async () => {
      process.env.TEST_DATABASE_URL = adminUrl;
      process.env.TEST_TEMPLATE_MODE = 'sharde';
      const before = process.env.TEST_PG_TEMPLATE;
      // Other files create and drop databases on this cluster in parallel, so only a name this setup
      // would build counts: this content's shared template, or a private one minted during the call.
      const shared = sharedTemplateName(hashMigrations(MIGRATIONS_FOLDER));
      const from = Date.now();
      const built = async () => {
        const to = Date.now();
        const rows = await admin<{ datname: string }[]>`
          SELECT datname FROM pg_database WHERE datname LIKE ${`${TEMPLATE_PREFIX}%`}`;
        return rows
          .map((r) => r.datname)
          .filter((name) => {
            if (name === shared) return true;
            const born = bornAt(name);
            const stampOnly = /^[0-9a-z]+_[0-9a-f]{8}$/.test(name.slice(TEMPLATE_PREFIX.length));
            return stampOnly && born !== null && born >= from && born <= to;
          })
          .sort();
      };
      const dbs = await built();
      const planted = [
        `test_case_${process.env.TEST_PG_RUN_TOKEN}_planted_${stamp()}`,
        sharedTemplateName(randomBytes(12).toString('hex')),
      ];

      await Promise.all([
        expect(globalSetup(project)).rejects.toThrow(/TEST_TEMPLATE_MODE="sharde"/),
        ...planted.map((name) => admin.unsafe(`CREATE DATABASE "${name}"`)),
      ]);

      try {
        expect(await built()).toEqual(dbs);
      } finally {
        for (const name of planted) retireScratchDb(adminUrl, name);
        await drainRetiredScratchDbs(60_000);
      }
      expect(process.env.TEST_PG_TEMPLATE).toBe(before);
    },
    SLOW,
  );
});
