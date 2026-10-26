import type { TestProject } from 'vitest/node';
import { integrationWorkers, workerLine } from './integration-workers.js';
import { resolveDbSource } from './schema-mode.js';
import {
  freshTemplateName,
  mintRunToken,
  reapAbandoned,
  sweepRunScratchDbs,
} from './scratch-db.js';
import {
  acquireSharedTemplate,
  resolveTemplateMode,
  type SharedTemplate,
} from './shared-template.js';

let stopContainer: (() => Promise<void>) | null = null;
let run: {
  url: string;
  token: string;
  fresh: string | null;
  shared: SharedTemplate | null;
} | null = null;

async function migrateDatabase(url: string): Promise<void> {
  const postgres = (await import('postgres')).default;
  const { drizzle } = await import('drizzle-orm/postgres-js');
  const { runMigrations } = await import('./migrate.js');

  const client = postgres(url, { max: 1 });
  try {
    await runMigrations(drizzle(client));
  } finally {
    await client.end({ timeout: 5 });
  }
}

async function reapLeftovers(adminUrl: string): Promise<void> {
  const postgres = (await import('postgres')).default;
  const admin = postgres(adminUrl, { max: 1 });
  try {
    await reapAbandoned(admin);
  } finally {
    await admin.end({ timeout: 5 });
  }
}

async function buildPrivateTemplate(adminUrl: string, name: string): Promise<void> {
  const postgres = (await import('postgres')).default;
  const admin = postgres(adminUrl, { max: 1 });
  try {
    await admin.unsafe(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.end({ timeout: 5 });
  }
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  await migrateDatabase(url.toString());
}

/** Say so where the instance syncs to disk: tests/README.md, *One database per worker slot*. */
async function reportDurability(adminUrl: string): Promise<void> {
  const postgres = (await import('postgres')).default;
  const admin = postgres(adminUrl, { max: 1 });
  try {
    const [row] = await admin<{ fsync: string }[]>`SHOW fsync`;
    if (row?.fsync === 'on') {
      console.log(
        '[integration] fsync is on at this instance: every table a case truncates in a slot ' +
          'database leaves files the next checkpoint must sync, and each CREATE or DROP DATABASE ' +
          'waits on that checkpoint. Run the test instance with fsync=off, as the container this ' +
          'suite starts does.',
      );
    }
  } finally {
    await admin.end({ timeout: 5 });
  }
}

/** The count vitest resolved, read off the run that uses it, and the rule that chose it. */
function reportWorkers(project: TestProject): void {
  const flag = project.vitest.config.cliOptions.maxWorkers;
  console.log(workerLine(integrationWorkers(), project.config.maxWorkers, flag));
}

export async function setup(project: TestProject): Promise<void> {
  const source = resolveDbSource(process.env);
  reportWorkers(project);
  let adminUrl = source.mode === 'schema' ? source.url : undefined;
  const { mode, rule } = resolveTemplateMode(process.env, Boolean(adminUrl));

  if (!adminUrl) {
    const { startPostgresContainer } = await import('./container.js');
    const container = await startPostgresContainer();
    adminUrl = container.url;
    stopContainer = container.stop;
  }

  const token = mintRunToken();
  await reapLeftovers(adminUrl);
  await reportDurability(adminUrl);

  let name: string;
  if (mode === 'shared') {
    const { MIGRATIONS_FOLDER } = await import('./migrate.js');
    const started = Date.now();
    const shared = await acquireSharedTemplate({
      adminUrl,
      migrationsFolder: MIGRATIONS_FOLDER,
      migrate: migrateDatabase,
    });
    name = shared.name;
    run = { url: adminUrl, token, fresh: null, shared };
    const took = ((Date.now() - started) / 1000).toFixed(1);
    console.log(
      `[integration] template ${name}, shared (${rule}): ${shared.built ? 'built' : 'reused'} in ${took}s`,
    );
  } else {
    name = freshTemplateName(token);
    await buildPrivateTemplate(adminUrl, name);
    run = { url: adminUrl, token, fresh: name, shared: null };
    console.log(`[integration] template ${name}, private (${rule}): built`);
  }

  process.env.TEST_PG_ADMIN_URL = adminUrl;
  process.env.TEST_PG_TEMPLATE = name;
  process.env.TEST_PG_RUN_TOKEN = token;
  // The workers this process forks are the only ones a slot database of this token is handed to.
  process.env.TEST_PG_RUN_OWNER = String(process.pid);
}

export async function teardown(): Promise<void> {
  if (run) {
    const finished = run;
    run = null;
    const postgres = (await import('postgres')).default;
    // A name the drain reached first comes back as `does not exist, skipping`, which is the sweep
    // doing its job rather than anything to read. What a drop is REFUSED over, the sweep retries
    // and then names.
    const admin = postgres(finished.url, { max: 1, onnotice: () => {} });
    try {
      // Every worker slot's database, which lives as long as the run, and every other scratch
      // database this run minted that the drain did not reach. Here rather than in the cases and
      // hooks that used them: this is the only teardown in the suite with no vitest budget over it,
      // so a `DROP DATABASE` waiting on the cluster's checkpoint costs a run its wall time and never
      // a case or a hook its verdict.
      await sweepRunScratchDbs(admin, finished.token);
      // Only a template this run built for itself is dropped; a shared one outlives every run.
      if (finished.fresh) {
        await admin.unsafe(`DROP DATABASE IF EXISTS "${finished.fresh}" WITH (FORCE)`);
      }
    } catch {
    } finally {
      await admin.end({ timeout: 5 });
      await finished.shared?.release();
    }
  }
  if (stopContainer) {
    await stopContainer();
    stopContainer = null;
  }
}
