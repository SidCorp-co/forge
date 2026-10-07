/**
 * A person's interface language is their own choice: unset it reads null (follow the project's
 * content language), `en` and `vi` are stored, null clears the choice again, and anything else is
 * refused by name with nothing written. Against real Postgres, through the route and the column.
 */

import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { pgConstraintName } from '../../src/lib/db-errors.js';
import { api, userToken } from '../helpers/api.js';
import { createTestUser, truncateAll } from '../helpers/factories.js';

let userId: string;
let token: string;

beforeEach(async () => {
  await truncateAll();
  userId = (await createTestUser({ verified: true })).id;
  token = await userToken(userId);
});

const read = () => api(token, 'GET', '/api/auth/me/preferences');
const patch = (body: unknown) => api(token, 'PATCH', '/api/auth/me/preferences', body);

describe('the interface language preference', () => {
  it('reads null for a person who never chose, not a default English', async () => {
    const r = await read();
    expect(r.status).toBe(200);
    expect(r.body.language).toBeNull();
  });

  it('stores vi and en, and null clears the choice', async () => {
    expect((await patch({ language: 'vi' })).body.language).toBe('vi');
    expect((await read()).body.language).toBe('vi');
    expect((await patch({ language: 'en' })).body.language).toBe('en');
    expect((await patch({ language: null })).body.language).toBeNull();
    expect((await read()).body.language).toBeNull();
  });

  it('a theme-only write does not turn the language into a choice', async () => {
    expect((await patch({ theme: 'dark' })).body.language).toBeNull();
  });

  it('refuses a language it does not offer, and writes nothing', async () => {
    await patch({ language: 'vi' });
    const r = await patch({ language: 'fr' });
    expect(r.status).toBe(400);
    expect((await read()).body.language).toBe('vi');
  });

  it('the column itself refuses a value outside en/vi', async () => {
    await patch({ theme: 'dark' });
    const err = await db
      .execute(sql`UPDATE user_preferences SET language = 'fr' WHERE user_id = ${userId}`)
      .catch((e: unknown) => e);
    expect(pgConstraintName(err)).toBe('user_preferences_language_chk');
  });
});
