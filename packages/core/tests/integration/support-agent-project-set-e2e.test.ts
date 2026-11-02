import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  // the bot's token and the product API's credential are sealed in the integration vault
  process.env.INTEGRATION_MASTER_KEY ??= Buffer.alloc(32, 5).toString('base64');
});

import { db } from '../../src/db/client.js';
import { api, userToken } from '../helpers/api.js';
import {
  addProjectMember,
  bindTestRunner,
  createTestIssue,
  createTestProject,
  createTestRequirement,
  createTestUser,
  rows,
} from '../helpers/factories.js';
import type { StandInRocketChat } from '../helpers/support-chat-server.js';
import { refusalCodes, SupportWorld, type Turn } from '../helpers/support-world.js';

/**
 * @direct-test-of packages/core/src/support/ops-scope.ts
 * @direct-test-of packages/core/src/support/agent-projects.ts
 * @direct-test-of packages/core/src/support/record.ts
 * @direct-test-of packages/core/src/support/search.ts
 * @direct-test-of packages/core/src/support/project-read.ts
 * @direct-test-of packages/core/src/integrations/rocketchat/support-binding.ts
 * @direct-test-of packages/core/src/integrations/rocketchat/room-handlers.ts
 * @direct-test-of packages/core/src/support/read.ts
 * @direct-test-of packages/core/src/support/result.ts
 * @direct-test-of packages/core/src/support/owner-ask-targets.ts
 * @direct-test-of packages/core/src/agent-sessions/chat-checkout.ts
 */

// ISS-874, for every channel agent rather than one bot. The trial (test group 6ae81413, 2026-11-02):
// the AdminHub agent, bound on adminhub-api, was asked where the "mark valid" button of the order
// detail page is, answered that the UI code was not on its side, and handed nothing to the
// adminhub-fe master. Here that binding follows adminhub-fe through `agent.projects`: it reads fe's
// tracker, knowledge and code and files a record to fe. A second, unrelated binding (an agent
// workspace following its web project) proves the shape is general. One agent also hears every
// message of a users' group and only mentions in a team group (`agent.rooms`), and one session
// answers a group: a second binding of it is refused by name.

const w = new SupportWorld();
let chat: StandInRocketChat;
const tag = randomUUID().slice(0, 6);
const API = `adminhub-api-${tag}`;
const FE = `adminhub-fe-${tag}`;
const DOCS = `adminhub-docs-${tag}`;
const OUTSIDE = `elsewhere-${tag}`;
const FE_CHECKOUT = '/srv/adminhub-fe';
let orgId = '';
let feId = '';
let homeAdmin = '';
const CHECK = {
  name: 'morning',
  at: '01:30',
  ask: 'What shipped, what is in progress and what is blocked, across the product.',
};

/** Run `model` on the next member turn after `send`, and wait until it ran. */
async function onNextAsk(
  send: () => Promise<string>,
  model: (
    turn: Turn,
    act: (a: Record<string, unknown>) => Promise<Record<string, unknown>>,
  ) => Promise<void>,
): Promise<{ thread: string; turn: Turn }> {
  await w.settleWarm();
  let seen: Turn | null = null;
  let done = false;
  w.box.model = async (turn, act) => {
    if (seen || !turn.messages.some((m) => m.from !== 'forge')) return;
    seen = turn;
    await model(turn, act);
    done = true;
  };
  const thread = await send();
  await expect.poll(() => done, { timeout: 15_000 }).toBe(true);
  return { thread, turn: seen as unknown as Turn };
}

const agentBlock = (extra: Record<string, unknown> = {}) => ({
  product: 'AdminHub, the back office',
  readers: 'users',
  grants: { abilities: ['read_checkout', 'file_items'] },
  projects: [FE],
  // the team's group hears only mentions; the users' group every message
  rooms: { [chat.rid2]: { readers: 'team', answers: 'mentions' } },
  checks: [{ ...CHECK, rid: chat.rid }],
  ...extra,
});

/** Write the binding's `agent` block through the binding door as `token`. */
async function writeAgent(token: string, agent: Record<string, unknown>) {
  const [b] = await rows<{ id: string }>(
    sql`SELECT id FROM integration_bindings WHERE connection_id = ${w.rcConnectionId}::uuid`,
  );
  const path = `/api/projects/${w.projectId}/bindings/${String(b?.id)}`;
  const got = await api(w.owner, 'GET', path);
  expect(got.status, JSON.stringify(got.body)).toBe(200);
  const document = got.body.document as { target: Record<string, unknown> };
  return api(token, 'PUT', path, {
    baseRevision: got.body.revision,
    document: { ...document, target: { ...document.target, agent } },
  });
}

const codesOf = (body: unknown) => refusalCodes(body as Record<string, unknown>);

beforeAll(async () => {
  await w.start();
  chat = w.chat as StandInRocketChat;
  const [home] = await rows<{ org_id: string }>(
    sql`SELECT org_id FROM projects WHERE id = ${w.projectId}::uuid`,
  );
  orgId = String(home?.org_id);
  await db.execute(sql`UPDATE projects SET slug = ${API} WHERE id = ${w.projectId}::uuid`);
  feId = (await createTestProject(w.ownerId, { orgId })).id;
  await db.execute(
    sql`UPDATE projects SET slug = ${FE}, name = 'AdminHub FE' WHERE id = ${feId}::uuid`,
  );
  const docsId = (await createTestProject(w.ownerId, { orgId })).id;
  await db.execute(sql`UPDATE projects SET slug = ${DOCS} WHERE id = ${docsId}::uuid`);
  // a project of another organization, which no binding of this one may follow
  const outsideId = (await createTestProject(w.ownerId)).id;
  await db.execute(sql`UPDATE projects SET slug = ${OUTSIDE} WHERE id = ${outsideId}::uuid`);
  // the box holds fe's checkout too, registered for fe
  const runner = await bindTestRunner(feId, w.box.deviceId);
  await db.execute(sql`UPDATE runners SET repo_path = ${FE_CHECKOUT} WHERE id = ${runner}::uuid`);
  await createTestIssue(feId, w.ownerId, 3, { status: 'in_progress', createdAt: new Date() });
  await createTestRequirement(feId, 4, 'Orders are marked valid from the detail page');
  const put = await api(w.owner, 'PUT', `/api/projects/${feId}/knowledge/order-detail`, {
    title: 'Order detail page',
    body: 'The mark valid button sits in the order detail header, beside the status badge.',
    kind: 'guide',
  });
  expect(put.status, JSON.stringify(put.body)).toBeLessThan(300);
  // an admin of the home project alone, who may not name the projects it does not administer
  const admin = await createTestUser({ verified: true });
  await addProjectMember(w.projectId, admin.id, 'admin');
  homeAdmin = await userToken(admin.id);
  await w.bindTarget({ rids: [chat.rid, chat.rid2], agent: agentBlock() });
}, 120_000);

afterAll(() => w.stop());

describe('ISS-874: a channel agent follows the projects its binding names', () => {
  it("reads each followed project's tracker, knowledge and project document by slug", async () => {
    const out: Record<string, Record<string, unknown>> = {};
    await onNextAsk(
      () => chat.say(chat.alice, 'Where is the mark valid button on the order detail page?'),
      async (_t, act) => {
        out.issues = await act({ action: 'issues', project: FE });
        out.requirements = await act({ action: 'requirements', project: FE });
        out.releases = await act({ action: 'releases', project: FE });
        out.search = await act({ action: 'search', query: 'mark valid button', project: FE });
        out.project = await act({ action: 'project', project: FE });
        out.projects = await act({ action: 'projects' });
        out.home = await act({ action: 'search', query: 'mark valid button' });
      },
    );
    expect(out.issues).toMatchObject({
      project: FE,
      issues: [
        expect.objectContaining({ key: expect.stringMatching(/-3$/), status: 'in_progress' }),
      ],
    });
    expect(out.requirements).toMatchObject({
      project: FE,
      requirements: [
        expect.objectContaining({ title: 'Orders are marked valid from the detail page' }),
      ],
    });
    expect(out.releases).toMatchObject({ project: FE, releases: [] });
    expect(JSON.stringify(out.search)).toContain(`knowledge:${FE}/order-detail`);
    expect(JSON.stringify(out.search)).toContain('order detail header');
    expect(out.project).toMatchObject({ project: FE, declared: false });
    const slugs = ((out.projects as { projects: { slug: string }[] }).projects ?? []).map(
      (p) => p.slug,
    );
    expect(slugs).toEqual([API, FE]);
    // with no project named, a read is the home project's: fe's page is not among its hits
    expect(JSON.stringify(out.home)).not.toContain('order-detail');
  });

  it('refuses by name a project it does not follow, on every read and on a record', async () => {
    const out: Record<string, unknown>[] = [];
    await onNextAsk(
      () => chat.say(chat.alice, 'And the other product?'),
      async (turn, act) => {
        const thread = turn.messages.find((m) => m.from !== 'forge')?.thread ?? '';
        for (const project of [OUTSIDE, DOCS]) {
          out.push(await act({ action: 'issues', project }));
          out.push(await act({ action: 'search', query: 'orders', project }));
          out.push(await act({ action: 'project', project }));
        }
        out.push(
          await act({
            action: 'record',
            thread,
            kind: 'request',
            title: 'Something for a project it does not follow',
            summary: 'It must never be filed anywhere.',
            project: OUTSIDE,
          }),
        );
      },
    );
    for (const o of out) {
      expect(refusalCodes(o), JSON.stringify(o)).toContain('OPS_OUT_OF_SCOPE');
      expect(JSON.stringify(o)).toContain(`follows ${API}, ${FE}`);
    }
  });

  it("files a record to the followed project it names, so it lands on that project's master", async () => {
    let proposal = '';
    const { thread } = await onNextAsk(
      () => chat.say(chat.alice, 'The mark valid button does nothing on order 81.'),
      async (turn, act) => {
        const m = turn.messages.find((x) => x.from !== 'forge');
        const out = await act({
          action: 'record',
          thread: m?.thread,
          kind: 'defect',
          title: 'Mark valid does nothing on the order detail page',
          summary: 'Pressing mark valid on order 81 leaves the order unchanged.',
          project: FE,
        });
        proposal = String(out.proposal ?? JSON.stringify(out));
      },
    );
    expect(proposal).toMatch(/^[A-Za-z0-9-]+$/);
    const { out } = await w.agreeBy(chat.alice, 'yes please pass it on', thread, proposal);
    expect(out, JSON.stringify(out)).toMatchObject({ recorded: true });
    const filed = await rows<{ project_id: string; title: string }>(
      sql`SELECT project_id, title FROM feedback WHERE title = 'Mark valid does nothing on the order detail page'`,
    );
    expect(filed).toEqual([
      { project_id: feId, title: 'Mark valid does nothing on the order detail page' },
    ]);
    const links = await rows<{ project_id: string }>(
      sql`SELECT l.project_id FROM support_feedback_links l JOIN feedback f ON f.id = l.feedback_id
           WHERE f.title = 'Mark valid does nothing on the order detail page'`,
    );
    expect(links).toEqual([{ project_id: feId }]);
  });

  it("is shown each followed project's checkout read-only and told where it is", async () => {
    const turns = w.box.turns.filter((t) => t.confined);
    expect(turns.length).toBeGreaterThan(0);
    for (const t of turns) expect(t.siblingCheckouts, t.event).toEqual([FE_CHECKOUT]);
    const briefed = w.box.turns.find((t) => t.text.includes('You also follow'))?.text ?? '';
    expect(briefed).toContain(`${FE} (AdminHub FE): its checkout, read-only, at ${FE_CHECKOUT}`);
  });

  it('runs its scheduled check over every project it follows', async () => {
    const { fireDueChecks } = await import('../../src/support/index.js');
    await w.settleWarm();
    let handed = '';
    let feIssues: Record<string, unknown> = {};
    let done = false;
    w.box.model = async (turn, act) => {
      const check = turn.messages.find((m) => m.thread.startsWith('check:'));
      if (!check || done) return;
      handed = check.text;
      feIssues = await act({ action: 'issues', project: FE });
      done = true;
    };
    await fireDueChecks(new Date('2026-11-03T01:30:00Z'));
    await expect.poll(() => done, { timeout: 15_000 }).toBe(true);
    expect(handed).toContain(`for each project you follow: ${API}, ${FE}`);
    expect(feIssues).toMatchObject({
      issues: [expect.objectContaining({ key: expect.stringMatching(/-3$/) })],
    });
  });
});

describe("ISS-874: a question for the owner names any followed project's issue", () => {
  it("asks the owner about a followed project's issue, and refuses one no followed project holds", async () => {
    const set = await writeAgent(
      w.owner,
      agentBlock({
        ownerRoom: chat.rid2,
        grants: { abilities: ['read_checkout', 'file_items'], owner: chat.alice.userId },
      }),
    );
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    const outs: Record<string, unknown>[] = [];
    await onNextAsk(
      () => chat.sayIn(chat.rid2, chat.bob, `@supportbot ask the owner about the fe issue ${tag}`),
      async (turn, act) => {
        const thread = turn.messages.find((m) => m.from !== 'forge')?.thread;
        outs.push(
          await act({
            action: 'ask_owner',
            thread,
            question: 'Ship the fix today?',
            record: 'ISS-99',
          }),
        );
        outs.push(
          await act({
            action: 'ask_owner',
            thread,
            question: 'Ship the fix today?',
            record: 'ISS-3',
          }),
        );
      },
    );
    expect(refusalCodes(outs[0]), JSON.stringify(outs[0])).toEqual([
      'SUPPORT_OWNER_RECORD_UNKNOWN',
    ]);
    expect(JSON.stringify(outs[0])).toContain(`${API}, ${FE}`);
    expect(refusalCodes(outs[1]), JSON.stringify(outs[1])).toEqual([]);
    const restored = await writeAgent(w.owner, agentBlock());
    expect(restored.status, JSON.stringify(restored.body)).toBe(200);
  });
});

describe('ISS-874: one agent hears each group as that group is set', () => {
  it("hears every message of the users' group and only mentions in the team's group", async () => {
    await w.settleWarm();
    const handed: string[] = [];
    w.box.model = async (turn) => {
      for (const m of turn.messages) if (m.from !== 'forge') handed.push(m.text);
    };
    await chat.sayIn(chat.rid2, chat.bob, `team chatter ${tag}`);
    await chat.say(chat.alice, `users question ${tag}`);
    await expect.poll(() => handed.some((t) => t.includes(`users question ${tag}`))).toBe(true);
    await chat.sayIn(chat.rid2, chat.bob, `@supportbot team question ${tag}`);
    await expect.poll(() => handed.some((t) => t.includes(`team question ${tag}`))).toBe(true);
    expect(handed.some((t) => t.includes(`team chatter ${tag}`))).toBe(false);
  });

  it("screens a reply for each group's own readers", async () => {
    const internal = 'Fixed once ORDER_VALIDATE_URL is set on fix/mark-valid.';
    let usersOut: Record<string, unknown> = {};
    await onNextAsk(
      () => chat.say(chat.alice, `is mark valid fixed ${tag}?`),
      async (turn, act) => {
        const m = turn.messages.find((x) => x.from !== 'forge');
        usersOut = await act({ action: 'reply', thread: m?.thread, text: internal });
      },
    );
    expect(refusalCodes(usersOut), JSON.stringify(usersOut)).toContain('SUPPORT_INTERNAL_CODE');
    let teamOut: Record<string, unknown> = {};
    await onNextAsk(
      () => chat.sayIn(chat.rid2, chat.bob, `@supportbot is mark valid fixed ${tag}?`),
      async (turn, act) => {
        const m = turn.messages.find((x) => x.from !== 'forge');
        teamOut = await act({ action: 'reply', thread: m?.thread, text: internal });
      },
    );
    expect(refusalCodes(teamOut), JSON.stringify(teamOut)).toEqual([]);
    await w.untilLines((lines) => lines.some((l) => l.text.includes('fix/mark-valid')));
  });
});

describe('ISS-874: who may set the project set and the per-group settings', () => {
  it('refuses a project outside the organization, the home project, and a group it does not answer', async () => {
    const outside = await writeAgent(w.owner, agentBlock({ projects: [FE, OUTSIDE] }));
    expect(codesOf(outside.body), JSON.stringify(outside.body)).toEqual([
      'SUPPORT_AGENT_PROJECT_UNKNOWN',
    ]);
    const home = await writeAgent(w.owner, agentBlock({ projects: [API] }));
    expect(codesOf(home.body)).toEqual(['SUPPORT_AGENT_PROJECT_UNKNOWN']);
    const room = await writeAgent(
      w.owner,
      agentBlock({ rooms: { 'GRP-not-bound': { answers: 'mentions' } } }),
    );
    expect(codesOf(room.body)).toEqual(['SUPPORT_ROOM_OVERRIDE_UNKNOWN']);
    const ownerRoom = await writeAgent(
      w.owner,
      agentBlock({ ownerRoom: chat.rid2, rooms: { [chat.rid2]: { readers: 'users' } } }),
    );
    expect(codesOf(ownerRoom.body)).toEqual(['SUPPORT_ROOM_OVERRIDE_UNKNOWN']);
  });

  it('takes a project added only from an admin of it, and keeps one already held', async () => {
    const refused = await writeAgent(homeAdmin, agentBlock({ projects: [FE, DOCS] }));
    expect(refused.status).toBe(422);
    expect(codesOf(refused.body)).toEqual(['SUPPORT_AGENT_PROJECT_NOT_ADMIN']);
    expect(JSON.stringify(refused.body)).toContain(`an admin of ${DOCS}`);
    // the home admin edits the rest of the block; fe, already held, is not asked for again
    const kept = await writeAgent(
      homeAdmin,
      agentBlock({ product: 'AdminHub, the shop back office' }),
    );
    expect(kept.status, JSON.stringify(kept.body)).toBe(200);
    // the org's owner administers docs, and adds it; dropping it again needs nothing
    const added = await writeAgent(w.owner, agentBlock({ projects: [FE, DOCS] }));
    expect(added.status, JSON.stringify(added.body)).toBe(200);
    const dropped = await writeAgent(homeAdmin, agentBlock());
    expect(dropped.status, JSON.stringify(dropped.body)).toBe(200);
  });

  it('refuses a second binding of a group already answered: one session answers a group', async () => {
    const second = await api(w.owner, 'POST', '/api/integration-connections', {
      provider: 'rocketchat',
      displayName: 'FE bot',
      config: { serverUrl: chat.serverUrl },
      secrets: { authToken: chat.bot.authToken, userId: chat.bot.userId },
      bindings: [
        {
          projectId: feId,
          role: 'service',
          target: {
            provider: 'rocketchat',
            rids: [chat.rid],
            agent: { product: 'AdminHub FE', grants: { abilities: ['file_items'] } },
          },
        },
      ],
    });
    expect(second.status, JSON.stringify(second.body)).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(second.body)).toContain('SUPPORT_ROOM_ANSWERED_TWICE');
    expect(JSON.stringify(second.body)).toContain(`project ${w.projectId}`);
  });

  it('is general: another binding follows its own sibling, and one naming none reaches its home alone', async () => {
    const { projectsInScope } = await import('../../src/support/ops-scope.js');
    // an agent workspace and its web project, in an organization of their own
    const ws = await createTestProject(w.ownerId);
    const [wsOrg] = await rows<{ org_id: string }>(
      sql`SELECT org_id FROM projects WHERE id = ${ws.id}::uuid`,
    );
    const web = await createTestProject(w.ownerId, { orgId: String(wsOrg?.org_id) });
    const webSlug = `workspace-web-${tag}`;
    await db.execute(sql`UPDATE projects SET slug = ${webSlug} WHERE id = ${web.id}::uuid`);
    const bind = (agent: Record<string, unknown>, rid: string) =>
      api(w.owner, 'POST', '/api/integration-connections', {
        provider: 'rocketchat',
        displayName: `Workspace bot ${rid}`,
        config: { serverUrl: chat.serverUrl },
        secrets: { authToken: chat.bot.authToken, userId: chat.bot.userId },
        bindings: [
          {
            projectId: ws.id,
            role: 'service',
            target: { provider: 'rocketchat', rids: [rid], agent },
          },
        ],
      });
    // naming a project of another organization (this world's fe) is refused for it too
    const foreign = await bind({ projects: [FE] }, chat.rid3);
    expect(JSON.stringify(foreign.body)).toContain('SUPPORT_AGENT_PROJECT_UNKNOWN');
    const single = await bind({ product: 'Workspace' }, chat.rid3);
    expect(single.status, JSON.stringify(single.body)).toBe(201);
    const room = {
      id: randomUUID(),
      projectId: ws.id,
      bindingId: String(
        (
          await rows<{ id: string }>(
            sql`SELECT id FROM integration_bindings WHERE project_id = ${ws.id}::uuid`,
          )
        )[0]?.id,
      ),
      kind: 'agent',
      scope: null,
    } as unknown as Parameters<typeof projectsInScope>[0];
    expect((await projectsInScope(room)).map((p) => p.id)).toEqual([ws.id]);
    const [b] = await rows<{ id: string; revision: number }>(
      sql`SELECT id, revision FROM integration_bindings WHERE project_id = ${ws.id}::uuid`,
    );
    const path = `/api/projects/${ws.id}/bindings/${String(b?.id)}`;
    const got = await api(w.owner, 'GET', path);
    const document = got.body.document as { target: Record<string, unknown> };
    const follows = await api(w.owner, 'PUT', path, {
      baseRevision: got.body.revision,
      document: { ...document, target: { ...document.target, agent: { projects: [webSlug] } } },
    });
    expect(follows.status, JSON.stringify(follows.body)).toBe(200);
    expect((await projectsInScope(room)).map((p) => p.slug)).toEqual([expect.any(String), webSlug]);
  });
});
