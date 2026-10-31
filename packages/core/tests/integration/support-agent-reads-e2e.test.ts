import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  // the bot's token and the source host's token are sealed in the integration vault
  process.env.INTEGRATION_MASTER_KEY ??= Buffer.alloc(32, 5).toString('base64');
  // the public origin an owner-mode clone's repository is relayed at
  process.env.PUBLIC_API_BASE_URL = 'https://forge.example';
});

import { randomUUID } from 'node:crypto';
import { db } from '../../src/db/client.js';
import { encryptJson } from '../../src/integrations/vault.js';
import { createTestIssue, createTestRequirement, rows } from '../helpers/factories.js';
import { seedProjectDocument } from '../helpers/release-world.js';
import type { StandInRocketChat } from '../helpers/support-chat-server.js';
import { SupportWorld, type Turn } from '../helpers/support-world.js';

/**
 * @direct-test-of packages/core/src/support/ops-acts.ts
 * @direct-test-of packages/core/src/support/ops-reads.ts
 * @direct-test-of packages/core/src/support/checks.ts
 */

// FB-448 (ISS-844), planted with agenfold's binding as it stood on forge-dev 0.4.0-dev.415: an `agent`
// block in owner mode with abilities read_checkout, file_items, deliver and owner_mode, and one
// check, `daily-report` at 01:30 UTC, asking what shipped, what is in progress, what is blocked and
// what the owner owes. Its check fired and every read of its own project's tracker was refused
// OPS_NOT_AN_OPERATIONS_ROOM, so the morning report (REQ-77 BC-13) could not be answered. A channel
// agent reads its own project as an operations room scoped to it does; its writes stay the support
// doors' (record, route, ask_owner).

const w = new SupportWorld();
let chat: StandInRocketChat;
let slug = '';
const OWNER_ID = 'u-alice';
const DAILY = {
  name: 'daily-report',
  at: '01:30',
  ask: 'What shipped yesterday, what is in progress, what is blocked, and what the owner owes.',
};

async function onCheckTurn(
  fire: () => Promise<unknown>,
  model: (
    turn: Turn,
    act: (a: Record<string, unknown>) => Promise<Record<string, unknown>>,
  ) => Promise<void>,
): Promise<Turn> {
  await w.settleWarm();
  let seen: Turn | null = null;
  let done = false;
  w.box.model = async (turn, act) => {
    if (seen || !turn.messages.some((m) => m.thread.startsWith('check:'))) return;
    seen = turn;
    await model(turn, act);
    done = true;
  };
  await fire();
  await expect.poll(() => done, { timeout: 15_000 }).toBe(true);
  return seen as unknown as Turn;
}

beforeAll(async () => {
  await w.start();
  chat = w.chat as StandInRocketChat;
  const [p] = await rows<{ slug: string }>(
    sql`SELECT slug FROM projects WHERE id = ${w.projectId}::uuid`,
  );
  slug = String(p?.slug);
  // owner mode works in its own clone, so the project names its source (as agenfold's does)
  await seedProjectDocument(w.projectId, w.ownerId, { defaultBranch: 'dev', environments: {} });
  const connectionId = randomUUID();
  await db.execute(sql`
    INSERT INTO integration_connections (id, owner_type, owner_id, provider, active, config, secrets_enc)
    VALUES (${connectionId}, 'user', ${w.ownerId}, 'gitlab', true,
            ${JSON.stringify({ baseUrl: 'https://gitlab.test' })}::jsonb,
            ${encryptJson({ token: 'glpat-the-connections-own-token' })})`);
  await db.execute(sql`
    INSERT INTO integration_bindings (id, connection_id, project_id, provider, role, active, config)
    VALUES (${randomUUID()}, ${connectionId}, ${w.projectId}, 'gitlab', 'source', true,
            ${JSON.stringify({ projectPath: 'acme/agenfold' })}::jsonb)`);
  await createTestIssue(w.projectId, w.ownerId, 7, {
    status: 'in_progress',
    createdAt: new Date(),
  });
  await createTestRequirement(w.projectId, 10, 'Orders sync to the warehouse nightly');
  await w.bindTarget({
    rids: [chat.rid],
    agent: {
      product: 'Agenfold, the agent workspace',
      readers: 'team',
      grants: {
        abilities: ['read_checkout', 'file_items', 'deliver', 'owner_mode'],
        owner: OWNER_ID,
      },
      checks: [{ ...DAILY, rid: chat.rid }],
    },
  });
}, 120_000);

afterAll(() => w.stop());

describe("an owner-mode channel agent reads its own project's tracker (FB-448)", () => {
  it('answers its daily check from issues, releases and requirements, and is told how', async () => {
    const { fireDueChecks } = await import('../../src/support/index.js');
    const out: Record<string, Record<string, unknown>> = {};
    const turn = await onCheckTurn(
      () => fireDueChecks(new Date('2026-11-01T01:30:00Z')),
      async (_t, act) => {
        out.issues = await act({ action: 'issues', project: slug });
        out.releases = await act({ action: 'releases', project: slug });
        out.requirements = await act({ action: 'requirements', project: slug });
        out.projects = await act({ action: 'projects' });
      },
    );
    for (const [read, body] of Object.entries(out)) {
      expect(JSON.stringify(body), read).not.toContain('OPS_NOT_AN_OPERATIONS_ROOM');
    }
    expect(out.issues).toMatchObject({
      project: slug,
      issues: [
        expect.objectContaining({ key: expect.stringMatching(/-7$/), status: 'in_progress' }),
      ],
    });
    expect(out.releases).toMatchObject({ project: slug, releases: [] });
    expect(out.requirements).toMatchObject({
      project: slug,
      requirements: [
        { key: 'REQ-10', title: 'Orders sync to the warehouse nightly', status: 'draft' },
      ],
    });
    expect(out.projects).toMatchObject({ projects: [{ slug }] });
    const handed = turn.messages.find((m) => m.thread.startsWith('check:'))?.text ?? '';
    expect(handed).toContain('support.issues, support.releases and support.requirements');
    expect(handed).toContain('as the persona speaks');
  });

  it('reads no project but its own, and writes no operations act: those stay the support doors', async () => {
    const { fireDueChecks } = await import('../../src/support/index.js');
    const out: Record<string, Record<string, unknown>> = {};
    await onCheckTurn(
      () => fireDueChecks(new Date('2026-11-02T01:30:00Z')),
      async (t, act) => {
        const thread = t.messages.find((m) => m.thread.startsWith('check:'))?.thread;
        out.other = await act({ action: 'issues', project: 'not-this-project' });
        out.move = await act({ action: 'move', thread: 'msg1', issue: 'ISS-7', to: 'closed' });
        await act({ action: 'check_result', check: thread, finding: null });
      },
    );
    expect(JSON.stringify(out.other)).toContain('OPS_OUT_OF_SCOPE');
    expect(JSON.stringify(out.other)).toContain("this room's scope is its own project");
    expect(JSON.stringify(out.move)).toContain('OPS_NOT_AN_OPERATIONS_ROOM');
    expect(JSON.stringify(out.move)).toContain('a channel agent writes through support.record');
  });
});
