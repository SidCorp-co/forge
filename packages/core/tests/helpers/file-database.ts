import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import { afterAll, beforeAll } from 'vitest';
import { TEST_PROCESS_ENV } from './global-setup.js';

const adminUrl = process.env.TEST_PG_ADMIN_URL;
const template = process.env.TEST_PG_TEMPLATE;
if (!adminUrl || !template) {
  throw new Error(
    'TEST_PG_ADMIN_URL / TEST_PG_TEMPLATE are unset, so global setup did not run: start the suite ' +
      'with `pnpm --filter @forge/core test:integration`, which boots its own Postgres.',
  );
}

const name = `file_${randomBytes(6).toString('hex')}`;
const admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
try {
  await admin.unsafe(`CREATE DATABASE "${name}" TEMPLATE "${template}"`);
} finally {
  await admin.end({ timeout: 5 });
}

const url = new URL(adminUrl);
url.pathname = `/${name}`;
process.env.DATABASE_URL = url.toString();
process.env.NODE_ENV = TEST_PROCESS_ENV.NODE_ENV;
process.env.LOG_LEVEL ??= TEST_PROCESS_ENV.LOG_LEVEL;
process.env.JWT_SECRET ??= TEST_PROCESS_ENV.JWT_SECRET;
process.env.DEVICE_TOKEN_PEPPER ??= TEST_PROCESS_ENV.DEVICE_TOKEN_PEPPER;

/**
 * Where this file's stored uploads land: a directory of its own, removed when the file ends. Never
 * the checkout's `./uploads`, the default `lib/env.ts` gives a server started with no UPLOADS_DIR,
 * which the suite once filled and left untracked in the tree. Set for every file, over anything
 * the shell exported, so no test writes into a real upload store.
 */
export const FILE_UPLOADS_DIR = mkdtempSync(join(tmpdir(), 'forge-it-uploads-'));
process.env.UPLOADS_DIR = FILE_UPLOADS_DIR;

/**
 * The process wired the way its entry wires it — every port provided, every route mounted, every
 * integration registered — and never served. In a hook rather than at the top of this file, so a
 * file's own `vi.mock` is registered before the entry's module graph is first loaded.
 */
beforeAll(async () => {
  await import('../../src/index.js');
  const { registerAllIntegrations } = await import('../../src/integration-registry.js');
  registerAllIntegrations();
});

afterAll(async () => {
  const boss = await import('../../src/queue/boss.js');
  if (boss.isBossStarted()) await boss.stopBoss();
  const { closeDb } = await import('../../src/db/client.js');
  await closeDb();
  rmSync(FILE_UPLOADS_DIR, { recursive: true, force: true });
});
