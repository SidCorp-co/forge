/**
 * What's new reads Forge's own released changes by time (`whats-new/read.ts`): the platform
 * project's released issues, each its user-facing note, unread after the reader's seen mark, a
 * Skip note, a missing note and a design-only landing never an entry. A weekly digest names only
 * its own week's entries. A person's product state holds a closed key namespace. Against real
 * Postgres, through the routes.
 */

import { randomUUID } from 'node:crypto';
import { isoWeekOf } from '@forge/contracts/whats-new';
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../src/db/client.js';
import { api, patToken, userToken } from '../helpers/api.js';
import {
  addProjectMember,
  createTestProject,
  createTestUser,
  seedOrg,
  truncateAll,
} from '../helpers/factories.js';

const PLATFORM = vi.hoisted(() => {
  const id = '7a1f0000-0000-4000-8000-00000000f0f0';
  process.env.FORGE_PLATFORM_PROJECT_ID = id;
  return id;
});

const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY);

let ownerId: string;
let ownerToken: string;
let agentId: string;
let agentToken: string;
let seq = 0;

async function seedPlatform(owner: string): Promise<void> {
  const orgId = await seedOrg(owner);
  await db.execute(sql`
    INSERT INTO projects (id, slug, name, org_id, created_by, agent_config)
    VALUES (${PLATFORM}, 'forge', 'Forge', ${orgId}, ${owner}, '{}'::jsonb)
  `);
}

async function issue(
  note: unknown,
  artifacts?: unknown,
  landing?: string,
  at?: number,
): Promise<{ id: string; key: string }> {
  const id = randomUUID();
  seq = at ?? seq + 1;
  await db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id, release_notes, merged_at,
                        merged_artifacts, merged_landing)
    VALUES (${id}, ${PLATFORM}, ${seq}, ${`issue ${seq}`}, 'awaiting_release', ${ownerId},
            ${note === null ? null : JSON.stringify(note)}::jsonb, now(),
            ${artifacts ? JSON.stringify(artifacts) : null}::jsonb, ${landing ?? null})
  `);
  return { id, key: `ISS-${seq}` };
}

async function shipped(version: string, at: Date, issueIds: string[]): Promise<void> {
  await db.execute(sql`
    INSERT INTO pipeline_runs (id, project_id, kind, status, started_at, release_version, release_released_at, metadata)
    VALUES (${randomUUID()}, ${PLATFORM}, 'system', 'completed', ${at.toISOString()}::timestamptz, ${version},
            ${at.toISOString()}::timestamptz, ${JSON.stringify({ source: 'release-batch', issueIds })}::jsonb)
  `);
}

const UI = [{ surface: 'ui', ref: 'screen:/releases/:v', change: 'added' }];
const API = [{ surface: 'api', ref: 'GET /api/x', change: 'changed' }];
const DESIGN = [{ surface: 'design', ref: 'issue-to-release@rev10', change: 'changed' }];

let oldFix: { id: string; key: string };
let screen: { id: string; key: string };
let improved: { id: string; key: string };
let skipped: { id: string; key: string };
let silent: { id: string; key: string };
let designed: { id: string; key: string };
let designApproval: { id: string; key: string };
let blank: { id: string; key: string };

beforeEach(async () => {
  await truncateAll();
  seq = 0;
  ownerId = (await createTestUser({ verified: true })).id;
  ownerToken = await userToken(ownerId);
  await seedPlatform(ownerId);
  agentId = (await createTestUser({ kind: 'agent' })).id;
  await addProjectMember(PLATFORM, agentId, 'member');
  agentToken = await patToken(agentId, [PLATFORM]);

  oldFix = await issue({ section: 'Fixed', userFacing: 'An old fix.' }, API);
  screen = await issue(
    { section: 'Added', userFacing: 'A release page starts with what it changes.' },
    UI,
    undefined,
    319,
  );
  improved = await issue(
    { section: 'Changed', userFacing: 'Integrations reads true.' },
    API,
    undefined,
    320,
  );
  skipped = await issue({ section: 'Skip', userFacing: 'An internal refactor.' }, API);
  silent = await issue(null, API);
  designed = await issue({ section: 'Changed', userFacing: 'A design text.' }, DESIGN);
  designApproval = await issue(
    { section: 'Added', userFacing: 'A design approved.' },
    undefined,
    'forge-workflow:issue-to-release@rev10',
  );
  blank = await issue({ section: 'Added', userFacing: ' - ' }, API);
  await shipped('0.1.0', ago(10), [oldFix.id]);
  await shipped('0.2.0', ago(2), [
    improved.id,
    screen.id,
    skipped.id,
    silent.id,
    designed.id,
    designApproval.id,
    blank.id,
  ]);
});

type Feed = {
  unread: number;
  seenAt: string | null;
  counts: { new: number; screens: number; improved: number; fixed: number };
  away: null | { days: number; highlights: string[]; counts: { screens: number } };
  days: Array<{
    date: string;
    entries: Array<{
      key: string;
      kind: string;
      ui: boolean;
      surfaces: string[];
      version: string;
      unread: boolean;
      week: string;
      tour: unknown;
    }>;
  }>;
  digests: Array<{ week: string; entryKeys: string[]; author: { agency: string } }>;
};

const feed = async (query = '') => {
  const r = await api(ownerToken, 'GET', `/api/me/whats-new${query}`);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body as unknown as Feed;
};
const keysOf = (f: Feed) => f.days.flatMap((d) => d.entries.map((e) => e.key));
const seen = (at: Date, token = ownerToken) =>
  api(token, 'PUT', '/api/me/product-state/whats_new_seen_at', { value: { at: at.toISOString() } });

describe("What's new reads released notes by time", () => {
  it('lists released user-facing notes, a new screen first, and never a Skip, a missing note, a blank note or a design-only landing', async () => {
    const f = await feed();
    expect(keysOf(f)).toEqual([screen.key, improved.key, oldFix.key]);
    for (const k of [skipped.key, silent.key, designed.key, designApproval.key, blank.key]) {
      expect(keysOf(f)).not.toContain(k);
    }
    const first = f.days[0]?.entries[0];
    expect(first).toMatchObject({
      key: 'ISS-319',
      kind: 'new',
      ui: true,
      surfaces: ['ui'],
      version: '0.2.0',
      tour: { id: 'release-what-changes', revision: 1 },
    });
    expect(f.days[0]?.entries[1]).toMatchObject({
      key: improved.key,
      kind: 'improved',
      ui: false,
      tour: null,
    });
  });

  it('reads only what shipped after `since`', async () => {
    const f = await feed(`?since=${encodeURIComponent(ago(5).toISOString())}`);
    expect(keysOf(f)).toEqual([screen.key, improved.key]);
  });

  it('counts unread after the seen mark, and a mark at now clears it', async () => {
    const never = await feed();
    expect(never.seenAt).toBeNull();
    expect(never.unread).toBe(3);

    expect((await seen(ago(5))).status).toBe(200);
    const after = await feed();
    expect(after.unread).toBe(2);
    expect(after.counts).toEqual({ new: 1, screens: 1, improved: 1, fixed: 0 });
    expect(after.away).toBeNull();
    expect(after.days.flatMap((d) => d.entries).find((e) => e.key === oldFix.key)?.unread).toBe(
      false,
    );

    expect((await seen(new Date())).status).toBe(200);
    expect((await feed()).unread).toBe(0);
  });

  it('summarises for a reader away seven days or more, a new screen the first highlight', async () => {
    await seen(ago(12));
    const f = await feed();
    expect(f.away).toMatchObject({ days: 12, highlights: [screen.key, improved.key, oldFix.key] });
    expect(f.away?.counts.screens).toBe(1);
    expect(f.unread).toBe(3);
  });

  it('refuses a time zone it does not know, by name', async () => {
    const r = await api(ownerToken, 'GET', '/api/me/whats-new?tz=Mars/Olympus');
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('WHATS_NEW_TIME_ZONE_UNKNOWN');
  });
});

describe('a weekly digest names only its own week', () => {
  const week = () => isoWeekOf(ago(2));
  const digest = (
    body: Record<string, unknown>,
    token = agentToken,
    project = PLATFORM,
    w = week(),
  ) => api(token, 'PUT', `/api/projects/${project}/whats-new/weeks/${w}/digest`, body);

  it("reads a week's entries for the agent that writes its digest", async () => {
    const r = await api(agentToken, 'GET', `/api/projects/${PLATFORM}/whats-new/weeks/${week()}`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((r.body.entries as Array<{ key: string }>).map((e) => e.key)).toEqual([
      screen.key,
      improved.key,
    ]);
    expect(r.body.digest).toBeNull();
  });

  it('refuses a digest that names an entry of another week, naming the key', async () => {
    const r = await digest({ title: 'Week', body: 'Short.', entryKeys: [screen.key, oldFix.key] });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('WHATS_NEW_DIGEST_FOREIGN_ENTRY');
    expect(JSON.stringify(r.body)).toContain(`${oldFix.key} is not an entry of ${week()}`);
  });

  it('refuses a digest over 120 words', async () => {
    const r = await digest({
      title: 'Week',
      body: Array(121).fill('word').join(' '),
      entryKeys: [screen.key],
    });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('WHATS_NEW_DIGEST_TOO_LONG');
  });

  it('writes, then replaces, the week digest and the feed shows it with its agent author', async () => {
    const first = await digest({
      title: 'Week',
      body: 'Releases say what they change.',
      entryKeys: [screen.key],
    });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.act).toBe('written');
    const again = await digest({
      title: 'Week',
      body: 'Releases and Integrations.',
      entryKeys: [screen.key, improved.key],
    });
    expect(again.body.act).toBe('replaced');
    const f = await feed();
    expect(f.digests).toEqual([
      expect.objectContaining({
        week: week(),
        entryKeys: [screen.key, improved.key],
        author: expect.objectContaining({ agency: 'agent' }),
      }),
    ]);
  });

  it("refuses a digest on a project that is not Forge's own", async () => {
    const other = await createTestProject(ownerId);
    const r = await digest(
      { title: 'W', body: 'B', entryKeys: [screen.key] },
      ownerToken,
      other.id,
    );
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('WHATS_NEW_NOT_PLATFORM_PROJECT');
  });

  it('refuses a viewer, who holds no whats-new.write', async () => {
    const viewer = (await createTestUser({ verified: true })).id;
    await addProjectMember(PLATFORM, viewer, 'viewer');
    const r = await digest(
      { title: 'W', body: 'B', entryKeys: [screen.key] },
      await userToken(viewer),
    );
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('PERMISSION_FORBIDDEN');
  });

  it('refuses a week that is not a week, and a week not yet begun', async () => {
    const bad = await digest(
      { title: 'W', body: 'B', entryKeys: [screen.key] },
      agentToken,
      PLATFORM,
      '2026-W99',
    );
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('WHATS_NEW_WEEK_INVALID');
    const ahead = await digest(
      { title: 'W', body: 'B', entryKeys: [screen.key] },
      agentToken,
      PLATFORM,
      isoWeekOf(new Date(Date.now() + 14 * DAY)),
    );
    expect(ahead.status).toBe(422);
    expect(JSON.stringify(ahead.body)).toContain('WHATS_NEW_WEEK_AHEAD');
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
