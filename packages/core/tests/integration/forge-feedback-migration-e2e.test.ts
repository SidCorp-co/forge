/**
 * Migration 0506, run by drizzle's own migrator over the rows a deploy can find (REQ-47): a token's
 * agent-report grant becomes the Forge door's, a held chat write under the project door's old name
 * keeps a name agreeing to it still records, no home project is guessed, and a stored grant the
 * rename cannot map aborts the whole migration naming it.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  groundBefore,
  type MigrationDb,
  type MigrationGround,
} from '../helpers/migration-ground.js';

const TAG = '0506_feedback_about_forge_is_filed_by_its_reporter';

let ground: MigrationGround;
let m: MigrationDb;
let userId: string;
let projectId: string;

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
  const orgId = randomUUID();
  await m.sql`INSERT INTO users (id, email, password_hash, kind) VALUES (${userId}, ${`${userId}@forge.test`}, '!x', 'human')`;
  await m.sql`INSERT INTO organizations (id, slug, name, is_personal, created_by) VALUES (${orgId}, ${`org-${orgId.slice(0, 8)}`}, 'Org', false, ${userId})`;
  await m.sql`INSERT INTO projects (id, slug, name, org_id, created_by) VALUES (${projectId}, 'forge', 'Forge', ${orgId}, ${userId})`;
});

afterEach(async () => {
  await m.drop();
});

async function token(name: string, permissions: string[]) {
  await m.sql`
    INSERT INTO personal_access_tokens (user_id, name, token_hash, token_prefix, permissions)
    VALUES (${userId}, ${name}, ${randomUUID()}, ${`fpat_${name}`.slice(0, 18)}, ${permissions})`;
}

const grantsOf = async (name: string) =>
  (
    await m.sql<
      { permissions: string[] }[]
    >`SELECT permissions FROM personal_access_tokens WHERE name = ${name}`
  )[0]?.permissions;

describe('0506: feedback about Forge is filed by its reporter', () => {
  it("renames a token's agent-report grant to the Forge door's, keeping every other grant", async () => {
    await token('box', ['projects:read', 'agent-reports:write', 'agent-reports:read']);
    await token('reader', ['issues:read']);
    await m.migrate();
    expect(await grantsOf('box')).toEqual([
      'projects:read',
      'forge-feedback:write',
      'forge-feedback:read',
    ]);
    expect(await grantsOf('reader')).toEqual(['issues:read']);
  });

  it('renames a held chat write under the project door to project_feedback, and nothing else', async () => {
    const conversation = randomUUID();
    await m.sql`INSERT INTO conversations (id, adapter, external_id) VALUES (${conversation}, 'web', ${randomUUID()})`;
    const held = (name: string) => m.sql`
      INSERT INTO chat_proposals (project_id, conversation_id, proposed_to, kind, form, call, summary)
      VALUES (${projectId}, ${conversation}, ${userId}, 'feedback', 'tool',
              ${m.sql.json({ name, arguments: { action: 'submit' } })}, ${m.sql.json({})})`;
    await held('forge_feedback');
    await held('forge_requirements');
    await m.migrate();
    const names = await m.sql<
      { name: string }[]
    >`SELECT call ->> 'name' AS name FROM chat_proposals ORDER BY 1`;
    expect(names.map((r) => r.name)).toEqual(['forge_requirements', 'project_feedback']);
  });

  it('names no home project: the instance has said nothing until an admin says it', async () => {
    await m.migrate();
    expect(await m.sql`SELECT * FROM instance_settings`).toEqual([]);
  });

  it('aborts naming a stored agent-report grant the rename cannot map, writing nothing', async () => {
    await token('odd', ['agent-reports:triage']);
    await token('box', ['agent-reports:write']);
    const failed = await m.migrate().then(
      () => null,
      (err: unknown) => String((err as { cause?: unknown }).cause ?? err),
    );
    expect(failed).toMatch(/PAT_GRANT_UNMAPPED: .*agent-reports:triage/);
    expect(await grantsOf('box')).toEqual(['agent-reports:write']);
    const [made] = await m.sql<
      { t: string | null }[]
    >`SELECT to_regclass('instance_settings')::text AS t`;
    expect(made?.t).toBeNull();
  });

  it('refuses a new agent report once applied, keeping the ones already filed', async () => {
    await m.sql`
      INSERT INTO agent_reports (project_id, kind, target, summary, signal_key)
      VALUES (${projectId}, 'bug', 'tool', 'filed before', 'tool:x')`;
    await m.migrate();
    const refused = await m.sql`
      INSERT INTO agent_reports (project_id, kind, target, summary, signal_key)
      VALUES (${projectId}, 'bug', 'tool', 'filed after', 'tool:x')`.then(
      () => null,
      (err: unknown) => (err as Error).message,
    );
    expect(refused).toMatch(/^AGENT_REPORTS_RETIRED/);
    expect(await m.sql`SELECT summary FROM agent_reports`).toEqual([{ summary: 'filed before' }]);
  });
});
