/**
 * What's new's own refusals and the person's product state it keeps its mark in. The release a
 * served instance shows is `whats-new-release-e2e.test.ts`; this file runs on an instance that was
 * told nothing about itself, which What's new refuses by name rather than guess. A person's product
 * state holds a closed key namespace. Against real Postgres, through the app's routes.
 */

import { WHATS_NEW_SEEN_KEY } from '@forge/contracts/product-state';
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { api, userToken } from '../helpers/api.js';
import { createTestUser, truncateAll } from '../helpers/factories.js';

const DAY = 86_400_000;

let ownerId: string;
let ownerToken: string;

beforeEach(async () => {
  await truncateAll();
  ownerId = (await createTestUser({ verified: true })).id;
  ownerToken = await userToken(ownerId);
});

const seen = (at: Date, token = ownerToken) =>
  api(token, 'PUT', '/api/me/product-state/whats_new_seen_at', { value: { at: at.toISOString() } });

describe("What's new on an instance that names no environment and no product project", () => {
  it.each(['/api/me/whats-new', '/api/me/whats-new/summary'])(
    'refuses %s by name, saying which settings to make',
    async (path) => {
      const r = await api(ownerToken, 'GET', path);
      expect(r.status, JSON.stringify(r.body)).toBe(503);
      expect(r.body.code).toBe('WHATS_NEW_INSTANCE_UNSET');
      expect(JSON.stringify(r.body)).toContain('FORGE_ENVIRONMENT');
      expect(JSON.stringify(r.body)).toContain('FORGE_PRODUCT_PROJECT_ID');
    },
  );

  it('refuses a mark naming a release, since no environment is declared to count it against', async () => {
    const r = await api(ownerToken, 'PUT', `/api/me/product-state/${WHATS_NEW_SEEN_KEY}`, {
      value: {
        at: new Date().toISOString(),
        release: { environment: 'dev', version: '0.1.0', at: new Date().toISOString() },
      },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(503);
    expect(r.body.code).toBe('RELEASE_SEEN_ENVIRONMENT_UNKNOWN');
    expect((await api(ownerToken, 'GET', '/api/me/product-state')).body.items).toEqual([]);
  });

  it("keeps a mark that names no release, as it was before What's new read releases", async () => {
    const r = await seen(new Date());
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  });
});

describe("a person's product state holds a closed key namespace", () => {
  it('refuses a key outside the namespace by name, and stores nothing', async () => {
    const r = await api(ownerToken, 'PUT', '/api/me/product-state/whats_new_last', {
      value: { at: new Date().toISOString() },
    });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('PRODUCT_STATE_KEY_UNKNOWN');
    const bad = await api(ownerToken, 'GET', '/api/me/product-state/tour:Not_Kebab');
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('PRODUCT_STATE_KEY_UNKNOWN');
    const list = await api(ownerToken, 'GET', '/api/me/product-state');
    expect(list.body.items).toEqual([]);
  });

  it('refuses a value outside the key shape and a mark later than now', async () => {
    const wrong = await api(ownerToken, 'PUT', '/api/me/product-state/whats_new_seen_at', {
      value: { when: 'yesterday' },
    });
    expect(wrong.status).toBe(400);
    expect(wrong.body.code).toBe('PRODUCT_STATE_VALUE_INVALID');
    const future = await seen(new Date(Date.now() + DAY));
    expect(future.status).toBe(400);
    expect(future.body.code).toBe('PRODUCT_STATE_VALUE_INVALID');
  });

  it('keeps a tour outcome per person, read back and listed', async () => {
    const value = { revision: 2, outcome: 'dismissed', step: 2, at: new Date().toISOString() };
    const put = await api(ownerToken, 'PUT', '/api/me/product-state/tour:release-what-changes', {
      value,
    });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    const got = await api(ownerToken, 'GET', '/api/me/product-state/tour:release-what-changes');
    expect(got.body).toMatchObject({ key: 'tour:release-what-changes', value });
    const someone = await userToken((await createTestUser({ verified: true })).id);
    const other = await api(someone, 'GET', '/api/me/product-state/tour:release-what-changes');
    expect(other.status).toBe(200);
    expect(other.body.value).toBeNull();
  });
});

describe('a tour run leaves its events', () => {
  const post = (body: unknown) => api(ownerToken, 'POST', '/api/me/tour-events', body);

  it('records started, a step skipped and a dismissal at a step', async () => {
    for (const body of [
      { tourId: 'integrations', revision: 1, kind: 'started' },
      { tourId: 'integrations', revision: 1, kind: 'step_skipped', step: 2 },
      { tourId: 'integrations', revision: 1, kind: 'dismissed', step: 3 },
    ]) {
      const r = await post(body);
      expect(r.status, JSON.stringify(r.body)).toBe(201);
    }
    const stored = (await db.execute(
      sql`SELECT kind, step FROM product_tour_events WHERE user_id = ${ownerId} ORDER BY created_at, kind`,
    )) as unknown as Array<{ kind: string; step: number | null }>;
    expect(stored.map((r) => `${r.kind}:${r.step ?? '-'}`).sort()).toEqual([
      'dismissed:3',
      'started:-',
      'step_skipped:2',
    ]);
  });

  it('refuses a tour the catalog does not hold, and a dismissal that names no step', async () => {
    const unknown = await post({ tourId: 'nowhere', revision: 1, kind: 'started' });
    expect(unknown.status).toBe(400);
    expect(JSON.stringify(unknown.body)).toContain(
      'is not a tour: it is one of release-what-changes, integrations',
    );
    const stepless = await post({ tourId: 'integrations', revision: 1, kind: 'dismissed' });
    expect(stepless.status).toBe(400);
    expect(JSON.stringify(stepless.body)).toContain('step names the step');
  });
});
