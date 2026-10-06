import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { afterAll } from 'vitest';

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
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL ??= 'silent';
process.env.JWT_SECRET ??= 'integration-secret-at-least-32-characters-long';
process.env.DEVICE_TOKEN_PEPPER ??= 'integration-pepper-at-least-32-characters-long';

await import('../../src/index.js');
const { registerAllIntegrations } = await import('../../src/integration-registry.js');
registerAllIntegrations();

afterAll(async () => {
  const boss = await import('../../src/queue/boss.js');
  if (boss.isBossStarted()) await boss.stopBoss();
  const { closeDb } = await import('../../src/db/client.js');
  await closeDb();
});
