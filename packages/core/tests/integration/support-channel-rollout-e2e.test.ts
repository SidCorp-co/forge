import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  // the bot's token, the product API's credential and the GitLab token are sealed in the vault
  process.env.INTEGRATION_MASTER_KEY ??= Buffer.alloc(32, 5).toString('base64');
  // the public origin a relayed repository is reached at
  process.env.PUBLIC_API_BASE_URL = 'https://forge.example';
});

import { db } from '../../src/db/client.js';
import { encryptJson } from '../../src/integrations/vault.js';
import { api } from '../helpers/api.js';
import { rows } from '../helpers/factories.js';
import { seedProjectDocument } from '../helpers/release-world.js';
import type { StandInRocketChat } from '../helpers/support-chat-server.js';
import { SUPPORT_BOX_CAPS, SupportWorld, type Turn } from '../helpers/support-world.js';

// REQ-77 r1 part 3 (ISS-765): scheduled checks and the switch-over, and forge-core-61's switch gate.
// - BC-13: a check the binding names fires once a day as a message to the agent, which answers it
//   with one finding core posts in the group, or none, and nothing is posted.
// - BC-16: a group answered by a bot outside Forge joins the agent only through its switch: every
//   duty passed, then the outside bot's account removed from the group, then the binding moved.
// - BC-18: a switch that waits on another runs only once that one is proven.
// - BC-19: a switch that needs the owner's word runs only with it; until then nothing changes.
// - c6: an owner-mode agent runs confined, in its own clone, and its git is handed a credential for
//   its own project's repository alone.
// The world is support-channel-agent-e2e's; the stand-in chat server holds two more groups, each
// answered outside Forge until it switches, and records each `groups.kick`.

const w = new SupportWorld();
let chat: StandInRocketChat;
const OWNER_ID = 'u-alice';
const GITLAB_HOST = 'gitlab.test';
const REPO = 'acme/catalog';
const OUTSIDE_BOT = { userId: 'u-babo', username: 'babo' };
const CHECK = {
  name: 'morning-check',
  at: '01:30',
  ask: 'Read the supplier tokens and the error log counts; a token expiring within 7 days is a finding.',
};

const agentBlock = (extra: Record<string, unknown> = {}) => ({
  product: 'Catalog, the shop back office',
  readers: 'team',
  grants: { abilities: ['file_items'] },
  checks: [{ ...CHECK, rid: chat.rid }],
  ...extra,
});

const projectPath = (rest: string) => `/api/projects/${w.projectId}${rest}`;
const switchPath = (rid: string, rest = '') => projectPath(`/support/channels/${rid}/switch${rest}`);

/** The binding's target as it is held now. */
async function heldTarget(): Promise<Record<string, unknown>> {
  const [b] = await rows<{ id: string }>(
    sql`SELECT id FROM integration_bindings WHERE connection_id = ${w.rcConnectionId}::uuid`,
  );
  const got = await api(w.owner, 'GET', projectPath(`/bindings/${String(b?.id)}`));
  expect(got.status, JSON.stringify(got.body)).toBe(200);
  return (got.body.document as { target: Record<string, unknown> }).target;
}

/** Run `model` on the next turn that carries a message matching `pick`, after `send`. */
async function onNextTurn(
  pick: (t: Turn) => boolean,
  send: () => Promise<unknown>,
  model: (
    turn: Turn,
    act: (a: Record<string, unknown>) => Promise<Record<string, unknown>>,
  ) => Promise<void>,
): Promise<Turn> {
  await w.settleWarm();
  let seen: Turn | null = null;
  let done = false;
  w.box.model = async (turn, act) => {
    if (seen || !pick(turn)) return;
    seen = turn;
    await model(turn, act);
    done = true;
  };
  await send();
  await expect.poll(() => done, { timeout: 15_000 }).toBe(true);
  return seen as unknown as Turn;
}

const checkTurn = (t: Turn) => t.messages.some((m) => m.thread.startsWith('check:'));
const topLevelLines = () => chat.linesIn(chat.rid).filter((l) => l.tmid === null);

beforeAll(async () => {
  await w.start();
  chat = w.chat as StandInRocketChat;
  await seedProjectDocument(w.projectId, w.ownerId, {
    defaultBranch: 'dev',
    environments: {},
  });
  // the project's source: a GitLab repository reached through Forge's relay (REQ-73 BC-5)
  const connectionId = randomUUID();
  await db.execute(sql`
    INSERT INTO integration_connections (id, owner_type, owner_id, provider, active, config, secrets_enc)
    VALUES (${connectionId}, 'user', ${w.ownerId}, 'gitlab', true,
            ${JSON.stringify({ baseUrl: `https://${GITLAB_HOST}` })}::jsonb,
            ${encryptJson({ token: 'glpat-the-connections-own-token' })})`);
  await db.execute(sql`
    INSERT INTO integration_bindings (id, connection_id, project_id, provider, role, active, config)
    VALUES (${randomUUID()}, ${connectionId}, ${w.projectId}, 'gitlab', 'source', true,
            ${JSON.stringify({ projectPath: REPO })}::jsonb)`);
  await w.bindTarget({
    rids: [chat.rid],
    outsideRids: [chat.rid2, chat.rid3, chat.rid4],
    agent: agentBlock(),
  });
}, 120_000);

afterAll(() => w.stop());

describe('REQ-77 BC-13: a scheduled check posts one finding, and nothing when there is none', () => {
  it('refuses checks on a support group, and a check posting in a group the agent does not answer', async () => {
    const onSupport = await w.retarget({
      agent: undefined,
      outsideRids: undefined,
      support: { ...agentBlock(), readers: undefined },
    });
    expect(onSupport.status, JSON.stringify(onSupport.body)).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(onSupport.body)).toContain('SUPPORT_CHECK_NOT_AGENT');
    const elsewhere = await w.retarget({
      agent: agentBlock({ checks: [{ ...CHECK, rid: chat.rid2 }] }),
    });
    expect(elsewhere.status, JSON.stringify(elsewhere.body)).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(elsewhere.body)).toContain('SUPPORT_CHECK_ROOM_UNKNOWN');
  });

  it('does not fire before its time, fires once at it, and a null result posts nothing', async () => {
    const { fireDueChecks } = await import('../../src/support/index.js');
    expect(await fireDueChecks(new Date('2026-11-02T01:29:00Z'))).toBe(0);
    const before = topLevelLines().length;
    let out: Record<string, unknown> = {};
    const turn = await onNextTurn(
      checkTurn,
      async () => {
        expect(await fireDueChecks(new Date('2026-11-02T01:30:00Z'))).toBe(1);
        // a second core, or the next sweep, fires the same day's check again: nothing more
        expect(await fireDueChecks(new Date('2026-11-02T08:00:00Z'))).toBe(0);
      },
      async (t, act) => {
        const m = t.messages.find((x) => x.thread.startsWith('check:'));
        out = await act({ action: 'check_result', check: m?.thread, finding: null });
      },
    );
    const handed = turn.messages.find((m) => m.thread.startsWith('check:'));
    expect(handed?.thread).toBe('check:morning-check:2026-11-02');
    expect(handed?.text).toContain(CHECK.ask);
    expect(out, JSON.stringify(out)).toMatchObject({ posted: null });
    await new Promise((r) => setTimeout(r, 300));
    expect(topLevelLines().length).toBe(before);
  });

  it('posts a finding once at the group’s top level, and refuses a second result', async () => {
    const { fireDueChecks } = await import('../../src/support/index.js');
    const before = topLevelLines().length;
    const results: Record<string, unknown>[] = [];
    await onNextTurn(
      checkTurn,
      () => fireDueChecks(new Date('2026-11-03T01:31:00Z')),
      async (t, act) => {
        const check = t.messages.find((x) => x.thread.startsWith('check:'))?.thread;
        results.push(
          await act({
            action: 'check_result',
            check,
            finding: 'The supplier token for Acme expires in 3 days.',
          }),
        );
        results.push(await act({ action: 'check_result', check, finding: 'Another finding.' }));
      },
    );
    expect(results[0], JSON.stringify(results[0])).toMatchObject({ posted: expect.any(String) });
    expect(JSON.stringify(results[1])).toContain('SUPPORT_CHECK_ANSWERED');
    const lines = topLevelLines().slice(before);
    expect(lines.map((l) => l.text)).toEqual(['The supplier token for Acme expires in 3 days.']);
  });

  it('refuses a result for a check that never fired', async () => {
    let out: Record<string, unknown> = {};
    await onNextTurn(
      (t) => t.messages.some((m) => m.from !== 'forge'),
      () => chat.say(chat.bob, 'how are the suppliers?'),
      async (_t, act) => {
        out = await act({
          action: 'check_result',
          check: 'check:morning-check:2026-01-01',
          finding: 'made up',
        });
      },
    );
    expect(JSON.stringify(out)).toContain('SUPPORT_CHECK_UNKNOWN');
  });
});

describe('REQ-77 BC-16: a group switches from its outside bot only through its duty checklist', () => {
  it('refuses moving an outside group into the agent with no switch planned', async () => {
    const moved = await w.retarget({ rids: [chat.rid, chat.rid2], outsideRids: [chat.rid3, chat.rid4] });
    expect(moved.status, JSON.stringify(moved.body)).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(moved.body)).toContain('AGENT_SWITCH_NOT_READY');
    expect(JSON.stringify(moved.body)).toContain('no switch is planned');
  });

  it('plans the switch, and refuses to run it, or the binding move, while a duty is open', async () => {
    // the outside bot declared itself on its group, as Orbit Babo does (REQ-75 r7 BC-42)
    const declared = await api(w.owner, 'PUT', projectPath(`/support/channels/${chat.rid2}/agent`), {
      role: 'Babo',
      box: 'hub box',
      address: 'tmux:orbit-chat-watch',
    });
    expect(declared.status, JSON.stringify(declared.body)).toBe(200);
    const planned = await api(w.owner, 'PUT', switchPath(chat.rid2), {
      outsideBot: OUTSIDE_BOT,
      duties: [
        { key: 'answers-in-thread', text: 'Answers a real request in its thread, results only' },
        { key: 'owner-mode', text: 'Does the owner’s write work, and only the owner’s' },
      ],
    });
    expect(planned.status, JSON.stringify(planned.body)).toBe(200);
    expect((planned.body.switch as { open: unknown[] }).open).toEqual([
      { kind: 'duty', key: 'answers-in-thread' },
      { kind: 'duty', key: 'owner-mode' },
    ]);
    const early = await api(w.owner, 'POST', switchPath(chat.rid2, '/apply'));
    expect(early.status, JSON.stringify(early.body)).toBe(409);
    expect(JSON.stringify(early.body)).toContain('duty answers-in-thread is not passed');
    const byHand = await w.retarget({ rids: [chat.rid, chat.rid2], outsideRids: [chat.rid3, chat.rid4] });
    expect(byHand.status, JSON.stringify(byHand.body)).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(byHand.body)).toContain('AGENT_SWITCH_NOT_READY');
    expect(chat.kicked).toEqual([]);
  });

  it('switches nothing when the chat server will not remove the outside bot', async () => {
    for (const key of ['answers-in-thread', 'owner-mode']) {
      const passed = await api(w.owner, 'POST', switchPath(chat.rid2, `/duties/${key}/pass`), {
        evidence: `seen in thread ${key} on the harness`,
      });
      expect(passed.status, JSON.stringify(passed.body)).toBe(200);
    }
    chat.kickRefused = true;
    const refused = await api(w.owner, 'POST', switchPath(chat.rid2, '/apply'));
    chat.kickRefused = false;
    expect(refused.status, JSON.stringify(refused.body)).toBe(503);
    expect(JSON.stringify(refused.body)).toContain('AGENT_SWITCH_BOT_NOT_REMOVED');
    expect((await heldTarget()).outsideRids).toContain(chat.rid2);
  });

  it('removes the outside bot from the group, clears its declaration, and moves the group to the agent', async () => {
    const applied = await api(w.owner, 'POST', switchPath(chat.rid2, '/apply'));
    expect(applied.status, JSON.stringify(applied.body)).toBe(200);
    expect((applied.body.switch as { switchedAt: string | null }).switchedAt).toBeTruthy();
    expect(chat.kicked).toEqual([{ rid: chat.rid2, userId: OUTSIDE_BOT.userId }]);
    const target = await heldTarget();
    expect(target.rids).toEqual([chat.rid, chat.rid2]);
    expect(target.outsideRids).toEqual([chat.rid3, chat.rid4]);
    const [channel] = await rows<{ agent_address: string | null }>(
      sql`SELECT agent_address FROM support_channels
           WHERE project_id = ${w.projectId}::uuid AND rid = ${chat.rid2}`,
    );
    expect(channel?.agent_address).toBeNull();
    const replan = await api(w.owner, 'PUT', switchPath(chat.rid2), {
      outsideBot: OUTSIDE_BOT,
      duties: [{ key: 'answers-in-thread', text: 'Answers a real request in its thread' }],
    });
    expect(replan.status).toBe(409);
    expect(JSON.stringify(replan.body)).toContain('AGENT_SWITCH_DONE');
  });
});

describe('REQ-77 BC-18: a switch waiting on another runs only once that one is proven', () => {
  it('refuses the later switch until the earlier group is marked proven', async () => {
    const first = await api(w.owner, 'GET', switchPath(chat.rid2));
    const firstId = (first.body.switch as { id: string }).id;
    const planned = await api(w.owner, 'PUT', switchPath(chat.rid3), {
      outsideBot: { userId: 'u-adminhub-babo' },
      duties: [{ key: 'morning-check', text: 'Posts the morning check finding, and nothing without one' }],
      after: firstId,
    });
    expect(planned.status, JSON.stringify(planned.body)).toBe(200);
    await api(w.owner, 'POST', switchPath(chat.rid3, '/duties/morning-check/pass'), {
      evidence: 'the check posted one finding on the harness',
    });
    const early = await api(w.owner, 'POST', switchPath(chat.rid3, '/apply'));
    expect(early.status, JSON.stringify(early.body)).toBe(409);
    expect(JSON.stringify(early.body)).toContain(`the switch of group ${chat.rid2} it waits on is not proven`);
    expect(chat.kicked.some((k) => k.rid === chat.rid3)).toBe(false);

    const unswitched = await api(w.owner, 'POST', switchPath(chat.rid4, '/proven'), { note: 'too soon' });
    expect(JSON.stringify(unswitched.body)).toMatch(/AGENT_SWITCH_(UNKNOWN|NOT_SWITCHED)/);
    const proven = await api(w.owner, 'POST', switchPath(chat.rid2, '/proven'), {
      note: 'answered a week of real requests as well as Babo did',
    });
    expect(proven.status, JSON.stringify(proven.body)).toBe(200);
    const after = await api(w.owner, 'POST', switchPath(chat.rid3, '/apply'));
    expect(after.status, JSON.stringify(after.body)).toBe(200);
    expect((await heldTarget()).rids).toEqual([chat.rid, chat.rid2, chat.rid3]);
  });
});

describe('REQ-77 BC-19: a switch needing the owner’s word waits for it, and nothing changes meanwhile', () => {
  it('refuses the mail-like switch without the owner’s word, and runs it with it', async () => {
    const planned = await api(w.owner, 'PUT', switchPath(chat.rid4), {
      outsideBot: { userId: 'u-mail-babo' },
      duties: [{ key: 'replies-to-mail', text: 'Answers a customer mail thread' }],
      ownerWord: true,
    });
    expect(planned.status, JSON.stringify(planned.body)).toBe(200);
    await api(w.owner, 'POST', switchPath(chat.rid4, '/duties/replies-to-mail/pass'), {
      evidence: 'answered on the harness',
    });
    const early = await api(w.owner, 'POST', switchPath(chat.rid4, '/apply'));
    expect(early.status, JSON.stringify(early.body)).toBe(409);
    expect(JSON.stringify(early.body)).toContain("the owner's word is not given");
    expect(chat.kicked.some((k) => k.rid === chat.rid4)).toBe(false);
    expect((await heldTarget()).outsideRids).toEqual([chat.rid4]);

    const stranger = await api(w.stranger, 'POST', switchPath(chat.rid4, '/owner-word'), {
      words: 'go ahead',
    });
    expect(stranger.status).toBe(403);
    const word = await api(w.owner, 'POST', switchPath(chat.rid4, '/owner-word'), {
      words: 'switch mail now',
    });
    expect(word.status, JSON.stringify(word.body)).toBe(200);
    const applied = await api(w.owner, 'POST', switchPath(chat.rid4, '/apply'));
    expect(applied.status, JSON.stringify(applied.body)).toBe(200);
    expect(chat.kicked.at(-1)).toEqual({ rid: chat.rid4, userId: 'u-mail-babo' });
  });
});

describe('ISS-765 c6: an owner-mode channel agent runs confined, its git reaching its own repository alone', () => {
  const RELAYED = `api/git/${GITLAB_HOST}/${REPO}.git`;
  const askGit = (token: string, path: string, host = 'forge.example') =>
    api(token, 'POST', projectPath('/support/session/git-credential'), { host, path });

  it('hands no git credential to an agent without owner mode', async () => {
    let answer: { status: number; body: Record<string, unknown> } | null = null;
    await onNextTurn(
      (t) => t.messages.some((m) => m.from !== 'forge'),
      () => chat.say(chat.bob, 'push my branch please'),
      async (t) => {
        answer = await askGit(t.token, RELAYED);
      },
    );
    expect(answer, JSON.stringify(answer)).toMatchObject({ status: 403 });
    expect(JSON.stringify(answer)).toContain('SUPPORT_GIT_NOT_OWNER_MODE');
  });

  it('places the owner-mode agent confined in its own clone of the development branch', async () => {
    const turns = w.box.turns.length;
    const granted = await w.retarget({
      agent: agentBlock({ grants: { abilities: ['file_items', 'owner_mode'], owner: OWNER_ID } }),
    });
    expect(granted.status, JSON.stringify(granted.body)).toBeLessThan(300);
    await w.settleWarm();
    const start = w.box.turns.slice(turns).find((t) => t.event === 'agent:start');
    expect(start).toMatchObject({ confined: true, checkout: 'own', buildBase: 'dev', ownHosts: [] });
    expect(start?.text).toContain('your own clone of the repository');
  });

  it('mints for its own repository, and refuses another one and a stranger', async () => {
    const answers: { status: number; body: Record<string, unknown> }[] = [];
    await onNextTurn(
      (t) => t.messages.some((m) => m.from !== 'forge'),
      () => chat.say(chat.alice, 'push the fix branch'),
      async (t) => {
        answers.push(await askGit(t.token, RELAYED));
        answers.push(await askGit(t.token, `api/git/${GITLAB_HOST}/acme/other.git`));
        answers.push(await askGit(t.token, 'someone/else.git', 'github.com'));
        answers.push(await askGit(w.stranger, RELAYED));
        // its own repository asked on GitLab itself: the connection's token never reaches a session
        answers.push(await askGit(t.token, `${REPO}.git`, GITLAB_HOST));
      },
    );
    const [own, other, github, stranger, direct] = answers;
    expect(direct?.status, JSON.stringify(direct)).toBe(409);
    expect(JSON.stringify(direct)).toContain('GIT_THROUGH_FORGE');
    expect(JSON.stringify(direct)).not.toContain('glpat');
    expect(own, JSON.stringify(own)).toMatchObject({ status: 200, body: { username: 'forge-relay' } });
    expect(String(own?.body.password)).not.toContain('glpat');
    for (const refused of [other, github]) {
      expect(refused?.status, JSON.stringify(refused)).toBe(403);
      expect(JSON.stringify(refused)).toContain('SUPPORT_GIT_NOT_OWN_REPO');
    }
    expect(JSON.stringify(stranger)).toContain('SUPPORT_NOT_THE_ROOM_SESSION');
  });

  it('reads unhealthy, and is never run, on a box that cannot confine it', async () => {
    const [box] = await rows<{ id: string }>(
      sql`SELECT device_id AS id FROM runners WHERE project_id = ${w.projectId}::uuid LIMIT 1`,
    );
    const older = { ...JSON.parse(SUPPORT_BOX_CAPS), ownerCheckouts: false };
    await db.execute(
      sql`UPDATE devices SET capabilities = ${JSON.stringify(older)}::jsonb WHERE id = ${box?.id}::uuid`,
    );
    try {
      const { forgetMemberships } = await import('../../src/support/index.js');
      forgetMemberships();
      const listedRooms = await api(w.owner, 'GET', projectPath('/support/rooms'));
      const health = JSON.stringify(
        (listedRooms.body.rooms as { rid: string; health: unknown }[]).find((r) => r.rid === chat.rid)
          ?.health,
      );
      expect(health).toContain('BOX_TOO_OLD');
      expect(health).toContain('ownerCheckouts');
    } finally {
      await db.execute(
        sql`UPDATE devices SET capabilities = ${SUPPORT_BOX_CAPS}::jsonb WHERE id = ${box?.id}::uuid`,
      );
    }
  });
});
