// ISS-1034 (codex F2) — preference writes serialize per person against a real
// Postgres over independent connections: writes racing on one account leave a
// trail in which every row's previous value is the row before it, and a restore
// racing a newer edit does not erase it.
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

let harness: TestDatabase;
let prefs: typeof import('../../src/auth/preference-changes.js');
const clients: Sql[] = [];
function independent(): ReturnType<typeof drizzle> {
  const client = postgres(harness.url, { max: 2, onnotice: () => {} });
  clients.push(client);
  return drizzle(client, {});
}

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.NODE_ENV ??= 'test';
  prefs = await import('../../src/auth/preference-changes.js');
}, 120_000);

afterAll(async () => {
  for (const c of clients) await c.end({ timeout: 5 }).catch(() => {});
  if (harness) await harness.cleanup();
});

let alice: string;
beforeEach(async () => {
  await truncateAll(harness.db);
  alice = (await createTestUser(harness.db)).id;
  await harness.db.execute(sql`UPDATE users SET email_verified_at = now()`);
});

const person = () => ({ kind: 'person' as const, userId: alice });

describe('preference writes on one person', () => {
  // cm:guard six writers on four connections, all racing, and the assertion is the CHAIN: each row's previous value is the newValue of the row before it in changedAt order. Without the per-user lock two writers read the same old value and one records a predecessor that never held (codex F2).
  it('leave a trail whose every row follows from the one before it', async () => {
    const styles = ['concise', 'detailed', 'bullets', 'default', 'concise', 'bullets'] as const;
    const dbs = [independent(), independent(), independent(), independent()];
    await Promise.all(
      styles.map((answerStyle, i) =>
        prefs.writeAssistantPreferences({
          userId: alice,
          patch: { answerStyle },
          actor: person(),
          db: dbs[i % dbs.length] as never,
        }),
      ),
    );
    const trail = (await prefs.listPreferenceChanges(alice))
      .filter((c) => c.field === 'answer_style')
      .sort((a, b) => a.changedAt.getTime() - b.changedAt.getTime() || a.id.localeCompare(b.id));
    expect(trail).toHaveLength(styles.length);
    expect(trail[0]?.previousValue).toBe('default');
    for (let i = 1; i < trail.length; i++) {
      expect(trail[i]?.previousValue, `row ${i}`).toBe(trail[i - 1]?.newValue);
    }
    const final = await prefs.readAssistantPreferences(alice);
    expect(final.answerStyle).toBe(trail.at(-1)?.newValue);
  });

  it('a restore of a superseded change is refused naming the later one, and erases nothing', async () => {
    await prefs.writeAssistantPreferences({
      userId: alice,
      patch: { answerStyle: 'concise' },
      actor: { kind: 'assistant', userId: null },
      conversationId: null,
    });
    const [assistantChange] = await prefs.listPreferenceChanges(alice);
    await prefs.writeAssistantPreferences({
      userId: alice,
      patch: { answerStyle: 'detailed' },
      actor: person(),
    });
    await expect(
      prefs.restorePreferenceChange({
        userId: alice,
        changeId: assistantChange?.id ?? '',
        actor: person(),
      }),
    ).rejects.toBeInstanceOf(prefs.PreferenceRestoreConflict);
    expect((await prefs.readAssistantPreferences(alice)).answerStyle).toBe('detailed');
  });
});
