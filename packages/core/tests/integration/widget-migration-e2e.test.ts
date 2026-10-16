/**
 * Migration 0505, run by drizzle's own migrator over the rows a deploy can find: the widget's
 * tables and the external reporter record land beside existing bindings and Feedback, and a
 * widget's site key names one binding — while a binding of another provider whose config happens
 * to hold a `siteKey` key is no widget's, and never blocks the index.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  groundBefore,
  type MigrationDb,
  type MigrationGround,
} from '../helpers/migration-ground.js';

const TAG = '0505_a_widget_visitor_files_feedback_behind_a_session';
const KEY = `fw_site_${'a'.repeat(32)}`;

let ground: MigrationGround;
let m: MigrationDb;
let userId: string;
let projectId: string;
let connectionId: string;
let feedbackId: string;

beforeAll(async () => {
  ground = await groundBefore(TAG);
}, 120_000);

afterAll(async () => {
  await ground.drop();
});

beforeEach(async () => {
  m = await ground.fresh();
  userId = randomUUID();
  projectId = randomUUID();
  connectionId = randomUUID();
  feedbackId = randomUUID();
  const orgId = randomUUID();
  await m.sql`INSERT INTO users (id, email, password_hash, kind) VALUES (${userId}, ${`${userId}@forge.test`}, '!x', 'human')`;
  await m.sql`INSERT INTO organizations (id, slug, name, is_personal, created_by) VALUES (${orgId}, ${`org-${orgId.slice(0, 8)}`}, 'Org', false, ${userId})`;
  await m.sql`INSERT INTO projects (id, slug, name, org_id, created_by) VALUES (${projectId}, ${`p-${projectId.slice(0, 8)}`}, 'P', ${orgId}, ${userId})`;
  await m.sql`INSERT INTO integration_connections (id, owner_type, owner_id, provider, config) VALUES (${connectionId}, 'user', ${userId}, 'agent', '{}'::jsonb)`;
  // two bindings of another provider, both holding the same `siteKey` value in their config
  for (const label of ['', 'second']) {
    await m.sql`INSERT INTO integration_bindings (project_id, connection_id, provider, role, config, label) VALUES (${projectId}, ${connectionId}, 'agent', 'service', ${m.sql.json({ siteKey: KEY })}, ${label})`;
  }
  await m.sql`INSERT INTO feedback (id, project_id, fb_seq, kind, title, where_seen, status, reported_by, reporter_agency) VALUES (${feedbackId}, ${projectId}, 1, 'bug', 'A bug', 'The board', 'new', ${userId}, 'human')`;
});

afterEach(async () => {
  await m.drop();
});

async function widgetBinding(siteKey: string) {
  return m.sql`INSERT INTO integration_bindings (project_id, connection_id, provider, role, config, label) VALUES (${projectId}, ${connectionId}, 'widget', 'service', ${m.sql.json({ siteKey })}, ${randomUUID().slice(0, 8)}) RETURNING id`;
}

describe('0505: a widget visitor files Feedback behind a session', () => {
  it('applies over existing bindings and Feedback, keeping every row', async () => {
    await m.migrate();
    const tables = await m.sql`
      SELECT table_name FROM information_schema.tables
       WHERE table_name IN ('widget_principals', 'widget_sessions', 'widget_drafts', 'feedback_external_reporters')
       ORDER BY table_name`;
    expect(tables.map((t) => t.table_name)).toEqual([
      'feedback_external_reporters',
      'widget_drafts',
      'widget_principals',
      'widget_sessions',
    ]);
    expect(await m.sql`SELECT id FROM integration_bindings WHERE provider = 'agent'`).toHaveLength(
      2,
    );
    expect(await m.sql`SELECT id FROM feedback WHERE id = ${feedbackId}`).toHaveLength(1);
  });

  it('refuses a second widget binding holding a site key one already holds', async () => {
    await m.migrate();
    await widgetBinding(KEY);
    const refused = await widgetBinding(KEY).then(
      () => null,
      (err: unknown) => err as { code?: string; constraint_name?: string },
    );
    expect(refused?.code).toBe('23505');
    expect(refused?.constraint_name).toBe('integration_bindings_widget_site_key_uq');
    await widgetBinding(`fw_site_${'b'.repeat(32)}`);
  });

  it('records an external reporter only with a status token digest and a known channel', async () => {
    await m.migrate();
    const visitorId = randomUUID();
    const bad = await m.sql`
      INSERT INTO feedback_external_reporters (feedback_id, project_id, channel, visitor_id, status_token_hash)
      VALUES (${feedbackId}, ${projectId}, 'email', ${visitorId}, ${'f'.repeat(64)})`.then(
      () => null,
      (err: unknown) => err as { constraint_name?: string },
    );
    expect(bad?.constraint_name).toBe('feedback_external_reporters_channel_chk');
    await m.sql`
      INSERT INTO feedback_external_reporters (feedback_id, project_id, channel, visitor_id, status_token_hash)
      VALUES (${feedbackId}, ${projectId}, 'widget', ${visitorId}, ${'f'.repeat(64)})`;
    expect(
      await m.sql`SELECT channel FROM feedback_external_reporters WHERE feedback_id = ${feedbackId}`,
    ).toEqual([{ channel: 'widget' }]);
  });
});
