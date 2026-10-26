import postgres from 'postgres';
import { mintRunToken, sweepRunScratchDbs } from '../scratch-db.js';

// A run of its own: the token the outer case minted (ISOLATION_TOKEN), over the outer template.
let token: string | null = null;

export function setup(): void {
  token = process.env.ISOLATION_TOKEN || mintRunToken();
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
