/**
 * A PAT request answers before three of its writes land: the audit row, the token's last use and the
 * `used` push. A test's reset that empties the tables under one of them deadlocks (40P01: the write
 * holds its own table and waits on the one its foreign key names, which the TRUNCATE took first), so
 * each is started through `lib/background.ts`, and `backgroundSettled()` returns only once all three
 * are written.
 */

import { eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { writeMcpAudit } from '../../src/credentials/mcp-audit.js';
import { db } from '../../src/db/client.js';
import { personalAccessTokens } from '../../src/db/schema.js';
import { backgroundSettled } from '../../src/lib/background.js';
import { api, patToken } from '../helpers/api.js';
import {
  addProjectMember,
  createTestProject,
  createTestUser,
  rows,
  truncateAll,
} from '../helpers/factories.js';

let ownerId = '';
let projectId = '';

beforeEach(async () => {
  await truncateAll();
  ownerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  await addProjectMember(projectId, ownerId, 'owner');
});

const PENDING = Symbol('pending');
const within = <T>(p: Promise<T>, ms: number) =>
  Promise.race([p, new Promise<typeof PENDING>((r) => setTimeout(() => r(PENDING), ms))]);

describe('the writes a PAT request does not wait on', () => {
  it('keep backgroundSettled waiting until they are written', async () => {
    const token = await patToken(ownerId, [projectId], 'settles');
    const { settled } = await db.transaction(async (tx) => {
      // the token's last use and the audit row's foreign key both wait on these two rows
      await tx.execute(
        sql`SELECT 1 FROM personal_access_tokens WHERE user_id = ${ownerId} FOR UPDATE`,
      );
      await tx.execute(sql`SELECT 1 FROM users WHERE id = ${ownerId} FOR UPDATE`);
      const res = await api(token, 'GET', `/api/projects/${projectId}`);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      writeMcpAudit({
        userId: ownerId,
        tokenId: null,
        deviceId: null,
        tool: 'settles',
        resultCode: 'ok',
      });
      const settled = backgroundSettled();
      expect(await within(settled, 300), 'settled while a write was blocked').toBe(PENDING);
      // wrapped, or the transaction would wait on the writes its own locks hold up
      return { settled };
    });
    await settled;

    const [pat] = await db
      .select({ lastUsedAt: personalAccessTokens.lastUsedAt })
      .from(personalAccessTokens)
      .where(eq(personalAccessTokens.userId, ownerId));
    expect(pat?.lastUsedAt, 'the token last use').not.toBeNull();
    const pushed = await rows<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM pipeline_outbox WHERE type = 'credential.tokenChanged'`,
    );
    expect(pushed[0]?.n, 'the used push').toBe(1);
    const audited = await rows<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM mcp_audit_log WHERE tool = 'settles'`,
    );
    expect(audited[0]?.n, 'the audit row').toBe(1);
  });
});
