import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  // the bot's token and the source host's token are sealed in the integration vault
  process.env.INTEGRATION_MASTER_KEY ??= Buffer.alloc(32, 5).toString('base64');
  // the public origin an owner-mode clone's repository is relayed at
  process.env.PUBLIC_API_BASE_URL = 'https://forge.example';
});

import { randomUUID } from 'node:crypto';
import { OPERATIONS_ACTION_GRANT } from '@forge/contracts/support-operations';
import { db } from '../../src/db/client.js';
import { getStorage } from '../../src/integrations/index.js';
import { encryptJson } from '../../src/integrations/vault.js';
import {
  createTestFeedback,
  createTestIssue,
  createTestRequirement,
  rows,
} from '../helpers/factories.js';
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
// ISS-1481: a page holding a credential, longer than the 6000 characters a read carries
const SECRET_PAGE = `<p>token ghp_aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bC1dE3fG5</p>${'y'.repeat(7000)}`;
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
  const seven = await createTestIssue(w.projectId, w.ownerId, 7, {
    status: 'in_progress',
    createdAt: new Date(),
  });
  for (const [body, ago] of [
    ['Root cause found in the sync job.', 120],
    ['Fix verified on staging; waiting on the release.', 60],
  ] as const) {
    await db.execute(sql`
      INSERT INTO comments (issue_id, author_id, body, created_at)
      VALUES (${seven.id}, ${w.ownerId}, ${body}, now() - make_interval(secs => ${ago}))`);
  }
  // ISS-1481: that page and a picture, attached to the issue
  for (const [name, mime, bytes] of [
    ['Loai Nghi Phep.html', 'text/html', Buffer.from(SECRET_PAGE)],
    ['mock.png', 'image/png', Buffer.from([0x89, 0x50, 0x4e, 0x47])],
  ] as const) {
    const { path } = await getStorage().put(`iss1481/${randomUUID()}/${name}`, bytes, mime);
    await db.execute(sql`
      INSERT INTO issue_attachments (issue_id, uploader_id, name, path, mime, size)
      VALUES (${seven.id}, ${w.ownerId}, ${name}, ${path}, ${mime}, ${bytes.length})`);
  }
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
        const key = (out.issues.issues as { key: string }[])[0]?.key;
        out.one = await act({ action: 'issues', project: slug, key });
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
    // ISS-999: one issue named by its key carries its latest notes, newest first; a list carries none
    expect(out.one).toMatchObject({
      issues: [
        expect.objectContaining({
          notes: [
            expect.objectContaining({ text: 'Fix verified on staging; waiting on the release.' }),
            expect.objectContaining({ text: 'Root cause found in the sync job.' }),
          ],
          handoffs: [],
        }),
      ],
    });
    expect(JSON.stringify(out.issues)).not.toContain('Root cause found');
    // ISS-1481: the one-issue read lists its attachments: a page with its text cut at 6000
    // characters and the room's secret taken out, a picture by name alone; a list carries none
    const one = (out.one?.issues ?? []) as { attachments?: Record<string, unknown>[] }[];
    const files = one[0]?.attachments;
    expect(files).toEqual([
      {
        name: 'Loai Nghi Phep.html',
        mime: 'text/html',
        size: Buffer.byteLength(SECRET_PAGE),
        text: expect.stringContaining('<p>token '),
        truncated: true,
      },
      { name: 'mock.png', mime: 'image/png', size: 4 },
    ]);
    // cut before it is scrubbed, so the secret's replacement can only shorten the text
    const pageText = String(files?.[0]?.text);
    expect(pageText.length).toBeGreaterThan(5900);
    expect(pageText.length).toBeLessThanOrEqual(6000);
    expect(JSON.stringify(files)).not.toContain('ghp_aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bC1dE3fG5');
    expect(JSON.stringify(out.issues)).not.toContain('Loai Nghi Phep');
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
        out.move = await act({
          action: 'move',
          thread: 'msg1',
          message: 'msg1',
          issue: 'ISS-7',
          to: 'closed',
        });
        await act({ action: 'check_result', check: thread, finding: null });
      },
    );
    expect(JSON.stringify(out.other)).toContain('OPS_OUT_OF_SCOPE');
    // a project outside its organization is refused, naming what it reaches (ISS-1243)
    expect(JSON.stringify(out.other)).toContain(
      `this room reaches every project of its organization (${slug})`,
    );
    expect(JSON.stringify(out.move)).toContain('OPS_NOT_AN_OPERATIONS_ROOM');
    expect(JSON.stringify(out.move)).toContain('a channel agent writes through support.record');
  });

  // ISS-1483 (dev.864, ninth round): a room is handed no master, team, judge or handle through a TITLE
  // or a name either. The guard is derived from the read acts: it enumerates every read the operations
  // grant declares, so a new read act with no poisoned call below turns the first assertion red, and
  // each call runs over rows whose every free-text field is poisoned.
  it('hands no internal word or handle through any free-text field of any read act', async () => {
    const WORDS = /\b(?:master|orchestrator|judge|steward|qa run)\b/i;
    const HANDLES = /ISS-9999|9e174d4534ab|PAT_PROJECT_OUTSIDE_FENCE/;
    const poison =
      'the master, orchestrator, judge, steward, a qa run: ISS-9999 9e174d4534ab PAT_PROJECT_OUTSIDE_FENCE';
    await db.execute(sql`UPDATE issues SET title = ${poison} WHERE project_id = ${w.projectId}`);
    await db.execute(
      sql`UPDATE requirements SET title = ${poison} WHERE project_id = ${w.projectId}`,
    );
    await db.execute(sql`UPDATE projects SET name = ${poison} WHERE id = ${w.projectId}::uuid`);
    await db.execute(
      sql`UPDATE comments SET body = ${poison} WHERE issue_id IN (SELECT id FROM issues WHERE project_id = ${w.projectId})`,
    );
    await db.execute(
      sql`UPDATE issue_attachments SET name = ${`${poison}.html`} WHERE issue_id IN (SELECT id FROM issues WHERE project_id = ${w.projectId})`,
    );
    await createTestFeedback(w.projectId, w.ownerId, 3);
    await db.execute(sql`UPDATE feedback SET title = ${poison} WHERE project_id = ${w.projectId}`);
    const { fireDueChecks } = await import('../../src/support/index.js');
    const calls: Record<string, (key: string) => Record<string, unknown>> = {
      projects: () => ({ action: 'projects' }),
      issues: (key) => ({ action: 'issues', project: slug, key }),
      releases: () => ({ action: 'releases', project: slug }),
      requirements: () => ({ action: 'requirements', project: slug }),
      feedback: () => ({ action: 'feedback', project: slug }),
    };
    const reads = Object.entries(OPERATIONS_ACTION_GRANT)
      .filter(([, grant]) => grant === 'read')
      .map(([action]) => action)
      .sort();
    expect(Object.keys(calls).sort(), 'a read act with no poisoned call here').toEqual(reads);
    const out: Record<string, unknown> = {};
    await onCheckTurn(
      () => fireDueChecks(new Date('2026-11-03T01:30:00Z')),
      async (_t, act) => {
        const list = await act({ action: 'issues', project: slug });
        const key = (list.issues as { key: string }[])[0]?.key as string;
        out.list = list;
        for (const [action, call] of Object.entries(calls)) out[action] = await act(call(key));
      },
    );
    // a note or an attachment's text is marked internal and stays in words, with its handles stripped
    const withoutRecords = (v: unknown): unknown =>
      Array.isArray(v)
        ? v.map(withoutRecords)
        : v && typeof v === 'object'
          ? Object.fromEntries(
              Object.entries(v as Record<string, unknown>)
                .filter(([k]) => k !== 'text')
                .map(([k, x]) => [k, withoutRecords(x)]),
            )
          : v;
    for (const [read, body] of Object.entries(out)) {
      expect(JSON.stringify(body), `${read} hands a handle`).not.toMatch(HANDLES);
      expect(JSON.stringify(withoutRecords(body)), `${read} hands an internal word`).not.toMatch(
        WORDS,
      );
    }
    expect(JSON.stringify(out.issues)).toContain('an issue');
  });
});
