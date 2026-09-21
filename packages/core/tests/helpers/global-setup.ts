import type { TestProject } from 'vitest/node';
import { reapAbandoned, templateDbName } from './scratch-db.js';

let stopContainer: (() => Promise<void>) | null = null;
let ownedTemplate: { url: string; name: string } | null = null;

async function buildTemplate(adminUrl: string, name: string): Promise<void> {
  const postgres = (await import('postgres')).default;
  const { drizzle } = await import('drizzle-orm/postgres-js');
  const { runMigrations } = await import('./migrate.js');

  const admin = postgres(adminUrl, { max: 1 });
  try {
    await reapAbandoned(admin);
    await admin.unsafe(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.end({ timeout: 5 });
  }

  const tplUrl = new URL(adminUrl);
  tplUrl.pathname = `/${name}`;
  const tplClient = postgres(tplUrl.toString(), { max: 1 });
  try {
    await runMigrations(drizzle(tplClient));
  } finally {
    await tplClient.end({ timeout: 5 });
  }
}

export async function setup(_project: TestProject): Promise<void> {
  let adminUrl = process.env.TEST_DATABASE_URL;

  if (!adminUrl) {
    const { startPostgresContainer } = await import('./container.js');
    const container = await startPostgresContainer();
    adminUrl = container.url;
    stopContainer = container.stop;
  }

  const name = templateDbName();
  await buildTemplate(adminUrl, name);
  ownedTemplate = { url: adminUrl, name };

  process.env.TEST_PG_ADMIN_URL = adminUrl;
  process.env.TEST_PG_TEMPLATE = name;
}

export async function teardown(): Promise<void> {
  if (ownedTemplate) {
    const postgres = (await import('postgres')).default;
    const admin = postgres(ownedTemplate.url, { max: 1 });
    try {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${ownedTemplate.name}" WITH (FORCE)`);
    } catch {
    } finally {
      await admin.end({ timeout: 5 });
      ownedTemplate = null;
    }
  }
  if (stopContainer) {
    await stopContainer();
    stopContainer = null;
  }
}
