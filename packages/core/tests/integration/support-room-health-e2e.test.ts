// @direct-test-of packages/core/src/support/delivery.ts
// @direct-test-of packages/core/src/support/last-resort.ts
// @direct-test-of packages/core/src/support/dispatch.ts
// @direct-test-of packages/core/src/support/one-voice.ts

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  // the bot's token and the product API's credential are sealed in the integration vault
  process.env.INTEGRATION_MASTER_KEY ??= Buffer.alloc(32, 5).toString('base64');
});

import { LAST_RESORT_LINES } from '../../src/conversations/last-resort.js';
import { db } from '../../src/db/client.js';
import { OFFLINE_GRACE_MS } from '../../src/support/last-resort.js';
import { api } from '../helpers/api.js';
import { rows } from '../helpers/factories.js';
import { seedProjectDocument } from '../helpers/release-world.js';
import { BASE, GrantedRoom } from '../helpers/support-grants-world.js';

// REQ-75 r5: what a room's grant shows its session of the checkout, why a room is not answering
// (BC-26), a room answering only mentions, and a build that would land on what production deploys.
// The world is support-grants-e2e's.

const g = new GrantedRoom();
const w = g.w;
let roomId = '';
let liveTarget = '';
const sessionDoes = (...a: Parameters<GrantedRoom['sessionDoes']>) => g.sessionDoes(...a);

/** The room's one box goes offline or comes back, as its heartbeat stopping or resuming reads. */
async function boxIs(status: 'online' | 'offline'): Promise<void> {
  const { withKernelMarker } = await import('../../src/db/kernel-marker.js');
  const seen = status === 'online' ? sql`now()` : sql`now() - interval '1 hour'`;
  await withKernelMarker(db, async (tx) => {
    await tx.execute(sql`UPDATE devices SET status = ${status} WHERE id = ${w.box.deviceId}`);
    await tx.execute(
      sql`UPDATE runners SET status = ${status}, last_seen_at = ${seen} WHERE device_id = ${w.box.deviceId}`,
    );
  });
}

/** The offline lines the room was told in `thread`. */
const offlineLinesIn = async (thread: string) =>
  (await w.chat.botLines()).filter(
    (l) => l.tmid === thread && l.text === LAST_RESORT_LINES.offline,
  );

/** The member's message in `thread`, recorded and still waiting, made to have waited `ms` already. */
async function waited(thread: string, ms: number): Promise<void> {
  await expect
    .poll(async () => {
      const held = await rows(sql`
        SELECT 1 FROM support_actions WHERE room_id = ${roomId}::uuid AND thread = ${thread}
           AND kind = 'message_in' AND delivered_at IS NULL`);
      return held.length;
    })
    .toBeGreaterThan(0);
  await rows(sql`
    UPDATE support_actions SET created_at = now() - make_interval(secs => ${ms / 1000})
     WHERE room_id = ${roomId}::uuid AND thread = ${thread} AND kind = 'message_in'`);
}

/** Two of the drain's ticks, as its process timer runs them every 2 s (`timer-registry.ts`). */
async function ticks(): Promise<void> {
  const { drainSupportRooms } = await import('../../src/support/dispatch.js');
  await drainSupportRooms();
  await drainSupportRooms();
}

beforeAll(async () => {
  await g.start();
  ({ roomId, liveTarget } = g);
}, 120_000);

afterAll(() => w.stop());

describe('REQ-75 r5: the session sees the checkout its grant names (BC-27)', () => {
  it('hands a read-only checkout to a room granted read_checkout, the build copy to one granted build, and none otherwise', async () => {
    const viewOf = async (grants: Record<string, unknown>) => {
      const held = await w.regrant({ ...BASE, grants });
      expect(held.status, JSON.stringify(held.body)).toBe(200);
      await w.settleWarm();
      const before = w.box.turns.length;
      await sessionDoes({ action: 'reply', text: 'Looking.' });
      const turn = w.box.turns.slice(before).find((t) => !t.warmUp);
      return { checkout: turn?.checkout, buildBase: turn?.buildBase };
    };
    expect(await viewOf({ abilities: ['read_checkout'] })).toEqual({
      checkout: 'read',
      buildBase: null,
    });
    expect(await viewOf({ abilities: ['file_items'] })).toEqual({
      checkout: 'none',
      buildBase: null,
    });
    expect(await viewOf({ abilities: ['read_checkout', 'build'], confirmers: ['alice'] })).toEqual({
      checkout: 'build',
      buildBase: 'dev',
    });
  });

  it('runs no turn on a box that cannot scope its checkout, and the room says the box is too old', async () => {
    await db.execute(
      sql`UPDATE devices SET capabilities = '{"followUpCredential": true, "turnCredential": true, "confinedChatNetwork": true}'::jsonb WHERE id = ${w.box.deviceId}`,
    );
    const { forgetMemberships } = await import('../../src/support/index.js');
    forgetMemberships();
    const [room] = await w.rooms();
    expect(room?.health).toMatchObject({
      healthy: false,
      causes: [expect.objectContaining({ code: 'BOX_TOO_OLD' })],
    });
    expect(JSON.stringify(room?.health)).toContain('chatCheckoutModes, supportBuilds');
    const { SUPPORT_BOX_CAPS } = await import('../helpers/support-world.js');
    await db.execute(
      sql`UPDATE devices SET capabilities = ${SUPPORT_BOX_CAPS}::jsonb WHERE id = ${w.box.deviceId}`,
    );
  });
});

describe('REQ-75 r5: a room that cannot answer says why (BC-26)', () => {
  it('names a bot that is not in the group', async () => {
    const { forgetMemberships } = await import('../../src/support/index.js');
    (w.chat as { botIsMember?: boolean }).botIsMember = false;
    forgetMemberships();
    const [room] = await w.rooms();
    expect(room?.health).toMatchObject({
      healthy: false,
      causes: [expect.objectContaining({ code: 'BOT_NOT_IN_ROOM' })],
    });
    (w.chat as { botIsMember?: boolean }).botIsMember = true;
    forgetMemberships();
    expect((await w.rooms())[0]?.health).toMatchObject({ healthy: true });
  });

  it('names a project with no box online to run the session', async () => {
    await boxIs('offline');
    const [room] = await w.rooms();
    expect(room?.health).toMatchObject({
      healthy: false,
      causes: expect.arrayContaining([expect.objectContaining({ code: 'NO_BOX' })]),
    });
    await boxIs('online');
  });

  // ISS-1406, Forge-Feedback 2026-11-22: the offline line stood at 02:45 beside the answer of 02:59
  it('tells a waiting thread the offline line once, only after the grace window, and hands it on when a box is back', async () => {
    await w.settleWarm();
    const seen: string[] = [];
    w.box.model = async (turn) => {
      for (const m of turn.messages) if (m.from !== 'forge') seen.push(m.text);
    };
    await boxIs('offline');
    const thread = await w.chat.say(w.chat.bob, 'is the export stuck?');
    await waited(thread, 0);
    await ticks();
    // [OFFLINE_NO_GRACE] before the fix: the line was posted on the message's first hand-over
    expect(await offlineLinesIn(thread)).toEqual([]);
    await waited(thread, OFFLINE_GRACE_MS + 1_000);
    await ticks();
    expect(await offlineLinesIn(thread)).toHaveLength(1);
    expect(seen).toEqual([]);
    await boxIs('online');
    // what the box coming online runs (`support/index.ts:registerSupportConsumers`)
    const { warmRoomsOfDevice } = await import('../../src/support/warm.js');
    await warmRoomsOfDevice(w.box.deviceId);
    // well inside the 30 s a failed dispatch waits: finding no box is not a failed dispatch
    await expect.poll(() => seen, { timeout: 5_000 }).toContain('is the export stuck?');
    await w.settleWarm();
  });

  // ISS-1467: a master never posts into a room its users read, so the answer a waiting thread of this
  // room holds is the room agent's reply; the master's post is refused by name and posts nothing
  it('tells no offline line to a thread answered within the grace window, and refuses a master post there', async () => {
    await w.settleWarm();
    const seen: string[] = [];
    w.box.model = async (turn) => {
      for (const m of turn.messages) if (m.from !== 'forge') seen.push(m.text);
    };
    await boxIs('offline');
    const thread = await w.chat.say(w.chat.bob, 'did my import finish?');
    await waited(thread, 0);
    const posted = await api(w.owner, 'POST', `/api/projects/${w.projectId}/support/master-posts`, {
      text: 'Your import finished at 09:10; every row is in.',
      rid: w.chat.rid,
      thread,
    });
    const refused = (posted.body as { error?: { refusals?: { code: string }[] } }).error;
    expect([posted.status, refused?.refusals?.[0]?.code], JSON.stringify(posted.body)).toEqual([
      409,
      'SUPPORT_MASTER_POST_USERS_ROOM',
    ]);
    expect((await w.chat.botLines()).filter((l) => l.tmid === thread)).toEqual([]);
    // the room agent's reply recorded in the thread after the message, as an answer the session gave
    await rows(sql`
      INSERT INTO support_actions (room_id, project_id, thread, kind, actor_kind, external_id, input)
      VALUES (${roomId}::uuid, ${w.projectId}::uuid, ${thread}, 'reply', 'session', 'answered-in-grace', '{"text": "Your import finished."}'::jsonb)`);
    await waited(thread, OFFLINE_GRACE_MS + 1_000);
    await ticks();
    expect(await offlineLinesIn(thread)).toEqual([]);
    await boxIs('online');
    const { warmRoomsOfDevice } = await import('../../src/support/warm.js');
    await warmRoomsOfDevice(w.box.deviceId);
    await expect.poll(() => seen, { timeout: 5_000 }).toContain('did my import finish?');
    await w.settleWarm();
  });

  it('names a binding switched off', async () => {
    await db.execute(
      sql`UPDATE integration_bindings SET active = false WHERE connection_id = ${w.rcConnectionId}::uuid`,
    );
    const [room] = await w.rooms();
    expect(room?.health).toMatchObject({
      healthy: false,
      causes: expect.arrayContaining([expect.objectContaining({ code: 'BINDING_OFF' })]),
    });
    await db.execute(
      sql`UPDATE integration_bindings SET active = true WHERE connection_id = ${w.rcConnectionId}::uuid`,
    );
  });

  it('names a room whose group left its binding, and warms neither it nor a room switched off', async () => {
    const { warmSupportRoom } = await import('../../src/support/warm.js');
    await w.settleWarm();
    const turns = () => w.box.turns.filter((t) => t.warmUp).length;
    const before = turns();

    await db.execute(
      sql`UPDATE integration_bindings SET config = jsonb_set(config, '{rids}', '["another-group"]'::jsonb) WHERE connection_id = ${w.rcConnectionId}::uuid`,
    );
    const left = (await w.rooms()).find((r) => r.id === roomId);
    expect(left?.health).toMatchObject({
      healthy: false,
      causes: expect.arrayContaining([expect.objectContaining({ code: 'ROOM_LEFT_BINDING' })]),
    });
    expect(JSON.stringify(left?.health)).toContain('no longer names group');
    expect(await warmSupportRoom(roomId, 'online')).toBe('unbound');

    await db.execute(
      sql`UPDATE integration_bindings SET config = jsonb_set(config, '{rids}', ${JSON.stringify([w.chat.rid])}::jsonb), active = false WHERE connection_id = ${w.rcConnectionId}::uuid`,
    );
    expect(await warmSupportRoom(roomId, 'online')).toBe('unbound');
    expect(turns()).toBe(before);

    await db.execute(
      sql`UPDATE integration_bindings SET active = true WHERE connection_id = ${w.rcConnectionId}::uuid`,
    );
    expect(await warmSupportRoom(roomId, 'online')).not.toBe('unbound');
  });
});

describe('REQ-75 r5: a room answering only mentions hands the session only those', () => {
  it('keeps the chat socket open when a binding is saved, and routes by the saved binding', async () => {
    const { rocketChatManager } = await import(
      '../../src/integrations/rocketchat/connection-manager.js'
    );
    // the stand-in counts each subscription core makes: one more each time it redials
    const subscriptions = () => (w.chat as { subscriptions?: number }).subscriptions;
    const subscribed = subscriptions();
    const held = await w.regrant({ ...BASE, answers: 'mentions', grants: { abilities: [] } });
    expect(held.status, JSON.stringify(held.body)).toBe(200);
    // the save's reload has reached the connection this process holds
    await expect
      .poll(
        () =>
          rocketChatManager.connections().get(w.rcConnectionId)?.routes.get(w.chat.rid)?.support
            ?.answers,
        { timeout: 15_000 },
      )
      .toBe('mentions');
    expect(subscriptions(), 'a binding save redialled the chat server').toBe(subscribed);
  });

  it('records every message and hands the session only one that names the bot', async () => {
    const held = await w.regrant({
      ...BASE,
      answers: 'mentions',
      grants: { abilities: ['read_checkout'] },
    });
    expect(held.status, JSON.stringify(held.body)).toBe(200);
    await w.settleWarm();
    const seen: string[] = [];
    w.box.model = async (turn) => {
      for (const m of turn.messages) if (m.from !== 'forge') seen.push(m.text);
    };
    const quiet = await w.chat.say(w.chat.bob, 'lunch at noon?');
    await w.chat.say(w.chat.bob, '@supportbot is the shop down?');
    await expect.poll(() => seen, { timeout: 15_000 }).toContain('@supportbot is the shop down?');
    expect(seen).not.toContain('lunch at noon?');
    const recorded = await rows<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM support_actions WHERE room_id = ${roomId}::uuid AND external_id = ${quiet}`,
    );
    expect(recorded[0]?.n).toBeGreaterThan(0);
  });
});

describe('REQ-75 r5: a build never changes what production deploys (BC-27)', () => {
  it('refuses a build where the development branch is the one production deploys from', async () => {
    const held = await w.regrant({
      ...BASE,
      grants: { abilities: ['read_checkout', 'build'], confirmers: ['alice'] },
    });
    expect(held.status, JSON.stringify(held.body)).toBe(200);
    await seedProjectDocument(w.projectId, w.ownerId, {
      defaultBranch: 'main',
      environments: {
        live: {
          tier: 'production',
          deploysFrom: 'main',
          deployment: { binding: liveTarget, trigger: 'on-request' },
        },
      },
    });
    const pushes = w.box.acts.filter((a) => a.event === 'build.push').length;
    const { out } = await sessionDoes({
      action: 'build',
      branch: 'fix/straight-to-prod',
      title: 'Straight to production',
      summary: 'A build that would land on what production deploys.',
    });
    expect(JSON.stringify(out)).toContain('SUPPORT_BUILD_REFUSED');
    expect(JSON.stringify(out)).toContain('is the branch production deploys from');
    expect(w.box.acts.filter((a) => a.event === 'build.push').length).toBe(pushes);
  });

  it('refuses a build onto a branch an environment deploys from, at the proposal and again at the agreement', async () => {
    const declare = (live: string) =>
      seedProjectDocument(w.projectId, w.ownerId, {
        defaultBranch: 'dev',
        environments: {
          live: {
            tier: 'production',
            deploysFrom: live,
            deployment: { binding: liveTarget, trigger: 'on-request' },
          },
        },
      });
    await declare('fix/live');
    const pushes = () => w.box.acts.filter((a) => a.event === 'build.push').length;
    const before = pushes();
    const onto = await sessionDoes({
      action: 'build',
      branch: 'fix/live',
      title: 'Straight onto live',
      summary: 'A build onto the branch production deploys.',
    });
    expect(JSON.stringify(onto.out)).toContain('SUPPORT_BUILD_REFUSED');
    expect(JSON.stringify(onto.out)).toContain(
      'fix/live is a branch this project deploys or promotes from',
    );

    // proposed while allowed; production moves onto the branch before the agreement
    const later = await sessionDoes({
      action: 'build',
      branch: 'fix/hotfix',
      title: 'A hotfix',
      summary: 'Proposed before production named this branch.',
    });
    expect(later.out).toMatchObject({ pending: true });
    await declare('fix/hotfix');
    const agreed = await w.agreeBy(
      w.chat.alice,
      'yes, build it',
      later.thread,
      String(later.out.proposal),
    );
    expect(agreed.out, JSON.stringify(agreed.out)).toMatchObject({ ran: false });
    expect(String(agreed.out.what)).toMatch(
      /^The build did not go ahead: fix\/hotfix is a branch this project deploys/,
    );
    expect(await w.linesIn(later.thread)).toEqual([]);
    expect(pushes()).toBe(before);
  });
});

describe('REQ-75 r5: a support room is set up in one save, its group picked from the bot (BC-25)', () => {
  it('lists the groups of a bot connection the admin may read, and refuses a connection that is not a bot', async () => {
    const { api } = await import('../helpers/api.js');
    const path = `/api/projects/${w.projectId}/integrations/rocketchat/connection-rooms`;
    const listed = await api(w.owner, 'POST', path, { connectionId: w.rcConnectionId });
    expect(listed.status, JSON.stringify(listed.body)).toBe(200);
    expect(listed.body.rooms).toEqual([
      expect.objectContaining({ rid: w.chat.rid, name: 'catalog-support' }),
    ]);
    const notBot = await api(w.owner, 'POST', path, { connectionId: w.apiConnectionId });
    expect(JSON.stringify(notBot.body)).toContain('not a Rocket.Chat bot');
    const stranger = await api(w.stranger, 'POST', path, { connectionId: w.rcConnectionId });
    expect(stranger.status).toBeGreaterThanOrEqual(403);
  });
});
