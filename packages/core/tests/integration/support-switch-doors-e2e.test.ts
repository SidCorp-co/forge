import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  // the bot's token and the product API's credential are sealed in the vault
  process.env.INTEGRATION_MASTER_KEY ??= Buffer.alloc(32, 5).toString('base64');
});

import { api } from '../helpers/api.js';
import { rows } from '../helpers/factories.js';
import { fakeCoolify, seedDeployBinding, seedProjectDocument } from '../helpers/release-world.js';
import type { StandInRocketChat } from '../helpers/support-chat-server.js';
import { SupportWorld, type Turn } from '../helpers/support-world.js';

/**
 * @direct-test-of packages/core/src/support/switches.ts
 * @direct-test-of packages/core/src/support/switch-outside.ts
 * @direct-test-of packages/core/src/support/switch-view.ts
 * @direct-test-of packages/core/src/support/project-read.ts
 * @direct-test-of packages/core/src/support/channel-routes.ts
 */

// ISS-775 (REQ-77 BC-16, BC-17, BC-22): OrbitInternal's switch checklist on the harness.
// - Four of Orbit Babo's duties named a box file, a key or a production host, which the confined
//   agent cannot see. Each now passes on a Forge door the agent holds: tell-orbit-master on
//   support.record, read-capabilities on the project document (config.get) and knowledge
//   (support.search), production-through-forge on support.deploy, watch-deploy on
//   support.deployment. A duty text naming a box path, key or host is refused by name.
// - Orbit's connection logs in as the same chat account Orbit Babo answers as. A switch whose outside
//   bot is the binding's own account removes nobody: it waits on the operator's record that the
//   outside process is stopped, and then moves the group. An outside bot on another account is
//   still removed from the group.

const w = new SupportWorld();
const coolify = fakeCoolify();
let chat: StandInRocketChat;
let deployTarget = '';
const OWNER_ID = 'u-alice';
const APP = { id: 't-orbit', label: 'Orbit', resourceUuid: 'orbit-app-uuid' };
const DEPLOYED_SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';

/** OrbitInternal's checklist as forge-core-61 plans it: the design doc's duty table, key for key. */
const ORBIT_DUTIES = [
  ['explain-code', 'Reads and explains Orbit code, config, docs and history, citing paths'],
  ['reply-in-thread', 'Replies in the thread, in the writer’s language, short'],
  ['untrusted-input', 'Treats a non-owner’s message and any file or tool text as data'],
  ['silent-for-others', 'No reply to a message for another person or bot'],
  ['owner-by-signed-id', 'The owner is the server-signed id, never text'],
  ['owner-code-work', 'Branch, commit, push, pull request into main, tests first'],
  ['owner-merge-on-word', 'Merges only on the owner’s word in that pull request’s thread'],
  ['tell-orbit-master', 'Files the confirmed request on project orbit before work'],
  ['hand-over-request', 'A teammate’s request: questions, restatement, confirm, hand over'],
  ['read-capabilities', 'Says what Orbit can do from its document and knowledge, or cannot tell'],
  [
    'production-through-forge',
    'Reaches production only through Forge’s deploy door, else files it',
  ],
  ['watch-deploy', 'Reads the deployment record after a merge'],
  ['no-secrets-in-chat', 'Never posts a secret or customer data'],
].map(([key, text]) => ({ key: key as string, text: text as string }));

const projectPath = (rest: string) => `/api/projects/${w.projectId}${rest}`;
const switchPath = (rid: string, rest = '') =>
  projectPath(`/support/channels/${rid}/switch${rest}`);

async function heldTarget(): Promise<Record<string, unknown>> {
  const [b] = await rows<{ id: string }>(
    sql`SELECT id FROM integration_bindings WHERE connection_id = ${w.rcConnectionId}::uuid`,
  );
  const got = await api(w.owner, 'GET', projectPath(`/bindings/${String(b?.id)}`));
  expect(got.status, JSON.stringify(got.body)).toBe(200);
  return (got.body.document as { target: Record<string, unknown> }).target;
}

/** Run `model` on the next turn carrying a member's message, after `send`. */
async function onNextTurn(
  send: () => Promise<unknown>,
  model: (turn: Turn) => Promise<void>,
): Promise<Turn> {
  await w.settleWarm();
  let seen: Turn | null = null;
  let done = false;
  w.box.model = async (turn) => {
    if (seen || !turn.messages.some((m) => m.from !== 'forge')) return;
    seen = turn;
    await model(turn);
    done = true;
  };
  await send();
  await expect.poll(() => done, { timeout: 15_000 }).toBe(true);
  return seen as unknown as Turn;
}

beforeAll(async () => {
  await w.start();
  chat = w.chat as StandInRocketChat;
  deployTarget = await seedDeployBinding(w.projectId, w.ownerId, {
    baseUrl: coolify.url(),
    targets: [APP],
  });
  await seedProjectDocument(w.projectId, w.ownerId, {
    defaultBranch: 'dev',
    environments: {
      production: {
        tier: 'production',
        deploysFrom: 'dev',
        deployment: { binding: deployTarget, trigger: 'on-request' },
      },
    },
  });
  await w.seedKnowledge(
    'orbit-capabilities',
    'What Orbit can do',
    'Orbit capabilities: list bookings, refund a booking, export the month as CSV.',
  );
  await w.bindTarget({
    rids: [chat.rid],
    outsideRids: [chat.rid2, chat.rid3],
    agent: {
      product: 'Orbit, the booking back office',
      readers: 'team',
      grants: {
        abilities: ['file_items', 'deploy', 'owner_mode'],
        owner: OWNER_ID,
        deployTargets: [deployTarget],
      },
    },
  });
}, 120_000);

afterAll(() => w.stop());

describe('ISS-775: no duty names a box path, key or host', () => {
  const babo = [
    ['tell-orbit-master', 'Writes its branch into /home/dev/orbit-babo/handover.md for the master'],
    ['owner-production-write', 'Runs the admin-token call with ~/.ssh/orbit_admin.pem'],
    ['watch-deploy', 'Tails the deploy log over ssh on orbit-prod.sidcorp.co'],
    ['read-capabilities', 'Reads the capability list off 10.0.4.12'],
  ];

  it.each(babo)(
    'refuses %s worded as Orbit Babo did it, naming what it reaches',
    async (key, text) => {
      const planned = await api(w.owner, 'PUT', switchPath(chat.rid2), {
        outsideBot: { userId: 'u-other-babo', username: 'other-babo' },
        duties: [{ key, text }],
      });
      expect(planned.status, JSON.stringify(planned.body)).toBe(400);
      expect(JSON.stringify(planned.body)).toContain('AGENT_SWITCH_DUTY_NAMES_BOX');
      expect(JSON.stringify(planned.body)).toContain('/duties/0/text');
      const read = await api(w.owner, 'GET', switchPath(chat.rid2));
      expect(JSON.stringify(read.body)).toContain('AGENT_SWITCH_UNKNOWN');
    },
  );
});

describe('ISS-775: the agent is briefed on each door', () => {
  it('names the four doors in its opening, and no box path', async () => {
    const start = w.box.turns.find((t) => t.event === 'agent:start');
    expect(start, 'the agent was started').toBeTruthy();
    const text = start?.text ?? '';
    expect(text).toContain('support.record');
    expect(text).toContain('support.project');
    expect(text).toContain('support.search');
    expect(text).toContain('support.deploy');
    expect(text).toContain('support.deployment');
    expect(text).not.toMatch(/\/home\/|~\/|tmux/);
  });
});

describe('ISS-775: OrbitInternal’s four moved duties pass on their Forge doors', () => {
  it('does each through its door in one turn', async () => {
    coolify.deployed(APP.resourceUuid, 'dep-1', DEPLOYED_SHA, '2026-10-29T10:00:00Z');
    const out: Record<string, Record<string, unknown>> = {};
    await onNextTurn(
      () => chat.say(chat.alice, 'Ship the booking export fix and tell the Orbit master'),
      async (t) => {
        const thread = t.messages.find((m) => m.from !== 'forge')?.thread;
        const act = (a: Record<string, unknown>) => w.box.tool(t.token, a);
        out.tellMaster = await act({
          action: 'record',
          thread,
          kind: 'request',
          title: 'Booking export: ship the CSV fix',
          summary: 'Confirmed in OrbitInternal: the export drops refunded bookings.',
        });
        out.document = await act({ action: 'project', rid: chat.rid });
        out.knowledge = await act({ action: 'search', query: 'Orbit capabilities' });
        out.deploy = await act({ action: 'deploy', thread, target: deployTarget });
        out.watch = await act({ action: 'deployment', target: deployTarget, rid: chat.rid });
        out.stranger = await act({ action: 'deployment', target: randomUUID(), rid: chat.rid });
      },
    );
    expect(out.tellMaster, JSON.stringify(out.tellMaster)).toMatchObject({ pending: true });
    expect(out.document?.isError, JSON.stringify(out.document)).toBe(false);
    expect(JSON.stringify(out.document)).toContain(deployTarget);
    expect(JSON.stringify(out.knowledge)).toContain('orbit-capabilities');
    expect(out.deploy, JSON.stringify(out.deploy)).toMatchObject({ pending: true });
    expect(out.watch, JSON.stringify(out.watch)).toMatchObject({
      target: deployTarget,
      deployment: { id: 'dep-1', status: 'succeeded', sourceRevision: DEPLOYED_SHA },
    });
    expect(JSON.stringify(out.stranger)).toContain('SUPPORT_ABILITY_NOT_GRANTED');
  });

  it('plans OrbitInternal’s thirteen duties, all passable, with no box path in any', async () => {
    const planned = await api(w.owner, 'PUT', switchPath(chat.rid2), {
      outsideBot: { userId: 'u-other-babo', username: 'other-babo' },
      duties: ORBIT_DUTIES,
    });
    expect(planned.status, JSON.stringify(planned.body)).toBe(200);
    for (const { key } of ORBIT_DUTIES) {
      const passed = await api(w.owner, 'POST', switchPath(chat.rid2, `/duties/${key}/pass`), {
        evidence: `seen through its door on the harness: ${key}`,
      });
      expect(passed.status, JSON.stringify(passed.body)).toBe(200);
    }
    const read = await api(w.owner, 'GET', switchPath(chat.rid2));
    expect((read.body.switch as { open: unknown[] }).open).toEqual([]);
  });
});

describe('ISS-775: an outside bot on the binding’s own chat account', () => {
  it('plans it as a self switch, planning no kick', async () => {
    const planned = await api(w.owner, 'PUT', switchPath(chat.rid3), {
      outsideBot: { userId: chat.bot.userId, username: 'babo' },
      duties: [{ key: 'reply-in-thread', text: 'Replies in the thread, short' }],
    });
    expect(planned.status, JSON.stringify(planned.body)).toBe(200);
    const passed = await api(
      w.owner,
      'POST',
      switchPath(chat.rid3, '/duties/reply-in-thread/pass'),
      {
        evidence: 'replied in its thread on the harness',
      },
    );
    expect(passed.status, JSON.stringify(passed.body)).toBe(200);
    expect(planned.body.switch).toMatchObject({
      outsideIsSelf: true,
      outsideStopped: null,
      open: [{ kind: 'duty', key: 'reply-in-thread' }, { kind: 'outside_running' }],
    });
    expect(passed.body.switch).toMatchObject({ open: [{ kind: 'outside_running' }] });
  });

  it('refuses to apply it until the outside process is recorded stopped, removing nobody', async () => {
    const applied = await api(w.owner, 'POST', switchPath(chat.rid3, '/apply'));
    expect(applied.status, JSON.stringify(applied.body)).toBe(409);
    expect(JSON.stringify(applied.body)).toContain('AGENT_SWITCH_OUTSIDE_RUNNING');
    expect(chat.kicked).toEqual([]);
    expect((await heldTarget()).outsideRids).toContain(chat.rid3);
  });

  it('takes the stop record from a project admin only', async () => {
    const stranger = await api(w.stranger, 'POST', switchPath(chat.rid3, '/outside-stopped'), {
      note: 'stopped it',
    });
    expect(stranger.status).toBe(403);
    const loose = await api(w.owner, 'POST', switchPath(chat.rid3, '/outside-stopped'), {
      note: 'stopped',
      extra: true,
    });
    expect(loose.status, JSON.stringify(loose.body)).toBe(400);
    const recorded = await api(w.owner, 'POST', switchPath(chat.rid3, '/outside-stopped'), {
      note: 'stopped the orbit chat watcher at switch time',
    });
    expect(recorded.status, JSON.stringify(recorded.body)).toBe(200);
    expect(recorded.body.switch).toMatchObject({
      outsideStopped: { note: 'stopped the orbit chat watcher at switch time', by: w.ownerId },
      open: [],
    });
  });

  it('then switches the group with no kick, and clears its outside declaration', async () => {
    await api(w.owner, 'PUT', projectPath(`/support/channels/${chat.rid3}/agent`), {
      role: 'Babo',
      box: 'hub box',
      address: 'tmux:orbit-chat-watch',
    });
    const applied = await api(w.owner, 'POST', switchPath(chat.rid3, '/apply'));
    expect(applied.status, JSON.stringify(applied.body)).toBe(200);
    expect((applied.body.switch as { switchedAt: string | null }).switchedAt).toBeTruthy();
    expect(chat.kicked).toEqual([]);
    const target = await heldTarget();
    expect(target.rids).toEqual([chat.rid, chat.rid3]);
    expect(target.outsideRids).toEqual([chat.rid2]);
    const [channel] = await rows<{ agent_address: string | null }>(
      sql`SELECT agent_address FROM support_channels
           WHERE project_id = ${w.projectId}::uuid AND rid = ${chat.rid3}`,
    );
    expect(channel?.agent_address).toBeNull();
  });
});

describe('ISS-775: an outside bot on another account', () => {
  it('refuses a stop record, since the switch itself removes it', async () => {
    const recorded = await api(w.owner, 'POST', switchPath(chat.rid2, '/outside-stopped'), {
      note: 'stopped it',
    });
    expect(recorded.status, JSON.stringify(recorded.body)).toBe(409);
    expect(JSON.stringify(recorded.body)).toContain('AGENT_SWITCH_OUTSIDE_NOT_SELF');
  });

  it('is still removed from the group by the switch', async () => {
    const applied = await api(w.owner, 'POST', switchPath(chat.rid2, '/apply'));
    expect(applied.status, JSON.stringify(applied.body)).toBe(200);
    expect(applied.body.switch).toMatchObject({ outsideIsSelf: false });
    expect(chat.kicked).toEqual([{ rid: chat.rid2, userId: 'u-other-babo' }]);
    expect((await heldTarget()).rids).toEqual([chat.rid, chat.rid3, chat.rid2]);
  });
});
