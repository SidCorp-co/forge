import { afterAll, beforeAll, expect, it } from 'vitest';
import { setupTestDatabase, type TestDatabase } from '../db.js';
import { databaseOf, leave } from './probe.js';

let t: TestDatabase;

beforeAll(async () => {
  t = await setupTestDatabase();
});

afterAll(async () => {
  await t?.cleanup();
});

it('is refused a second slot database while its first is open', async () => {
  leave('second-slot-db', await databaseOf(t.client));
  await expect(setupTestDatabase()).rejects.toThrow(/second shared slot database/);
});
