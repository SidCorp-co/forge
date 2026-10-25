import postgres from 'postgres';
import { mintRunToken, sweepRunScratchDbs } from '../scratch-db.js';

// A nested run is a run of its own: it mints its own token, so its workers are handed slot databases
// of their own and never one the outer run's workers are using. The template is the outer run's.
let token: string | null = null;

export function setup(): void {
  token = mintRunToken();
  process.env.TEST_PG_RUN_TOKEN = token;
  process.env.TEST_PG_RUN_OWNER = String(process.pid);
}

export async function teardown(): Promise<void> {
  const adminUrl = process.env.TEST_PG_ADMIN_URL;
  if (!token || !adminUrl) return;
  const admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
  try {
    await sweepRunScratchDbs(admin, token);
  } finally {
    await admin.end({ timeout: 5 });
  }
}
