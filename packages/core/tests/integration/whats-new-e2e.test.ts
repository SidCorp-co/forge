/**
 * What's new reads the CHANGELOG.md of the running build (`whats-new/changelog.ts`): the feed
 * answers on an instance that names no platform project, an entry is unread after the reader's seen
 * mark, a tour a fragment named is offered, and a digest the release folded in shows against its
 * week. A person's product state holds a closed key namespace. Against real Postgres: the routes
 * for the build's own changelog, the reader for a changelog and a clock the test holds.
 */

import { readFileSync } from 'node:fs';
import { WHATS_NEW_SEEN_KEY } from '@forge/contracts/product-state';
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { writeProductState } from '../../src/preferences/index.js';
import { changelogPath, parseChangelog } from '../../src/whats-new/changelog.js';
import { readWhatsNew } from '../../src/whats-new/read.js';
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

describe("What's new answers from this build's own changelog", () => {
  it('answers 200 on an instance that names no platform project, at the build version', async () => {
    const r = await api(ownerToken, 'GET', '/api/me/whats-new');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const newest = parseChangelog(readFileSync(changelogPath(), 'utf8'))[0];
    expect(r.body.version).toBe(newest?.version);
    expect(Array.isArray(r.body.days)).toBe(true);
    expect(r.body).not.toHaveProperty('projectId');
  });

  it('refuses a time zone it does not know, by name', async () => {
    const r = await api(ownerToken, 'GET', '/api/me/whats-new?tz=Mars/Olympus');
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('WHATS_NEW_TIME_ZONE_UNKNOWN');
  });
});

describe('the feed reads a changelog by time', () => {
  const RELEASES = parseChangelog(`# Changelog

## [2.0.0] - 2026-10-07

Newest

### Digest

- <!-- digest: 2026-W40 --> **The week.** Integrations and a fix.

### Added

- **A tour screen.** Offered. <!-- tour: integrations -->

### Changed

- **An improvement.** Better.

## [1.9.0] - 2026-10-02

Middle

### Fixed

- **Old fix.** Done.

## [1.0.0] - 2026-09-01

Old

### Added

- **Ancient.** Long ago.
`);
  const NOW = new Date('2026-10-08T12:00:00Z');
  const read = (since?: Date) =>
    readWhatsNew({ userId: ownerId, since, timeZone: 'UTC', now: NOW, releases: RELEASES });
  const keysOf = (f: Awaited<ReturnType<typeof read>>) =>
    f.days.flatMap((d) => d.entries.map((e) => e.key));
  const mark = (at: Date) =>
    writeProductState({
      userId: ownerId,
      key: WHATS_NEW_SEEN_KEY,
      value: { at: at.toISOString() },
      now: NOW,
    });

  it('lists the window newest day first, new before improved, with the version a day shipped in', async () => {
    const f = await read();
    expect(f.version).toBe('2.0.0');
    expect(f.days.map((d) => d.date)).toEqual(['2026-10-07', '2026-10-02']);
    expect(keysOf(f)).toEqual(['2.0.0#1', '2.0.0#2', '1.9.0#1']);
    expect(f.days[0]?.entries[0]).toMatchObject({
      title: 'A tour screen.',
      body: 'Offered.',
      kind: 'new',
      version: '2.0.0',
      week: '2026-W41',
    });
  });

  it('offers the tour an entry named, at the catalog revision, and no other', async () => {
    const entries = (await read()).days.flatMap((d) => d.entries);
    expect(entries.find((e) => e.key === '2.0.0#1')?.tour).toEqual({
      id: 'integrations',
      revision: 1,
    });
    expect(entries.filter((e) => e.tour !== null)).toHaveLength(1);
  });

  it('reads only what is dated after `since`', async () => {
    expect(keysOf(await read(new Date('2026-10-05T00:00:00Z')))).toEqual(['2.0.0#1', '2.0.0#2']);
  });

  it('counts unread after the seen mark, and a mark at now clears it', async () => {
    const never = await read();
    expect(never.seenAt).toBeNull();
    expect(never.unread).toBe(3);

    await mark(new Date('2026-10-04T00:00:00Z'));
    const after = await read();
    expect(after.unread).toBe(2);
    expect(after.counts).toEqual({ new: 1, improved: 1, fixed: 0 });
    expect(after.away).toBeNull();
    expect(after.days.flatMap((d) => d.entries).find((e) => e.key === '1.9.0#1')?.unread).toBe(
      false,
    );

    await mark(NOW);
    expect((await read()).unread).toBe(0);
  });

  it('summarises for a reader away seven days or more, a new entry the first highlight', async () => {
    await mark(new Date(NOW.getTime() - 12 * DAY));
    const f = await read();
    expect(f.away).toMatchObject({ days: 12, highlights: ['2.0.0#1', '2.0.0#2', '1.9.0#1'] });
    expect(f.unread).toBe(3);
  });

  it('shows the digest a release folded in, against the week it names, and drops it outside the window', async () => {
    expect((await read()).digests).toEqual([
      {
        week: '2026-W40',
        title: 'The week.',
        body: 'Integrations and a fix.',
        version: '2.0.0',
        releasedAt: '2026-10-07T00:00:00.000Z',
      },
    ]);
    expect((await read(new Date('2026-10-08T00:00:00Z'))).digests).toEqual([]);
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
