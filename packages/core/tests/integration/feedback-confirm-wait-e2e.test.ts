/**
 * ISS-902 (FB-480): an agent-reported item whose fix only a future event can test waits on the record.
 * agenfold's FB-470, FB-472 and FB-476 needed the owner's next message in the room, which the master
 * cannot cause, and were named on its owed line on every pass with nothing to act on. The master sets a
 * wait with its reason on either door; the line leaves the item out until the date passes or a member's
 * message arrives in the project's room, then names it again; the item shows why it waits.
 *
 * @direct-test-of packages/core/src/feedback/confirm-wait.ts
 * @direct-test-of packages/core/src/feedback/owed-verify.ts
 * @direct-test-of packages/core/src/forge-door/service.ts
 * @direct-test-of packages/core/src/masters/owed-confirms.ts
 */

import { sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { mintPat } from '../../src/credentials/pat.js';
import { PAT_GRANT_EPOCH } from '../../src/credentials/pat-permissions.js';
import { db } from '../../src/db/client.js';
import { meetRoomConfirmWaits } from '../../src/feedback/index.js';
import { api, type Body } from '../helpers/api.js';
import { addProjectMember, createTestProject, createTestUser } from '../helpers/factories.js';
import { ago, feedback, issue, type World, world } from '../helpers/forecast-world.js';

/** The Forge home project, and the reporter's own project with its master box. */
let home: World;
let own: World;
let channel = '';
const tokens = { master: '', box: '', stranger: '' };

interface Refused {
  code: string;
  path: string;
  detail: string;
}
const refusalOf = (body: Body): Refused | undefined =>
  ((body.error as { refusals?: Refused[] })?.refusals ?? [])[0];

const pat = async (userId: string, projectId: string, deviceId?: string) =>
  (
    await mintPat({
      permissions: ['*'],
      userId,
      name: deviceId ? 'checkout' : 'box',
      projectIds: [projectId],
      ...(deviceId ? { deviceId } : {}),
      grantEpoch: PAT_GRANT_EPOCH,
    })
  ).plaintext;

beforeAll(async () => {
  home = await world();
  own = await world();
  channel = (await createTestUser({ kind: 'agent' })).id;
  await db.execute(sql`UPDATE users SET display_name = 'agenfold-chat' WHERE id = ${channel}`);
  const master = (await createTestUser({ kind: 'agent' })).id;
  for (const id of [channel, master]) await addProjectMember(own.projectId, id);
  tokens.master = await pat(master, own.projectId, own.deviceId);
  tokens.box = (
    await mintPat({
      permissions: ['*'],
      userId: own.userId,
      name: 'master box',
      deviceId: own.deviceId,
      projectIds: [own.projectId],
    })
  ).plaintext;
  const elsewhere = (await createTestProject(home.userId)).id;
  const stranger = (await createTestUser({ kind: 'agent' })).id;
  await addProjectMember(elsewhere, stranger);
  tokens.stranger = await pat(stranger, elsewhere);
  await db.execute(sql`
    INSERT INTO instance_settings (id, forge_home_project_id) VALUES (1, ${home.projectId})
    ON CONFLICT (id) DO UPDATE SET forge_home_project_id = ${home.projectId}
  `);
}, 120_000);

/** FB-470: an item about Forge the channel agent filed from its own project, shipped. */
async function shippedForgeItem(): Promise<string> {
  const carrier = await issue(home, { status: 'closed', createdAt: ago(30), mergedAt: ago(2) });
  const key = await feedback(home, [carrier.id]);
  const [row] = (await db.execute(sql`
    UPDATE feedback SET reported_by = ${channel}, reporter_agency = 'agent'
     WHERE project_id = ${home.projectId} AND fb_seq = ${Number(key.slice(3))}
    RETURNING id
  `)) as unknown as { id: string }[];
  await db.execute(sql`
    INSERT INTO feedback_occurrences (feedback_id, reported_by, reporter_agency, source_project_id)
    VALUES (${String(row?.id)}, ${channel}, 'agent', ${own.projectId})
  `);
  return key;
}

/** The project-door twin: an item the channel agent filed in its own project, shipped. */
async function shippedOwnItem(): Promise<string> {
  const carrier = await issue(own, { status: 'closed', createdAt: ago(30), mergedAt: ago(2) });
  const key = await feedback(own, [carrier.id]);
  await db.execute(sql`
    UPDATE feedback SET reported_by = ${channel}, reporter_agency = 'agent'
     WHERE project_id = ${own.projectId} AND fb_seq = ${Number(key.slice(3))}
  `);
  return key;
}

const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();
const forgeWait = (token: string, key: string, body: Record<string, unknown>) =>
  api(token, 'POST', `/api/forge/feedback/${key}/confirm-wait`, body);
const ownWait = (token: string, key: string, body: Record<string, unknown>) =>
  api(token, 'POST', `/api/projects/${own.projectId}/feedback/${key}/confirm-wait`, body);

/** The wait's date moved into the past, as time passing would. */
async function lapse(projectId: string, key: string): Promise<void> {
  await db.execute(sql`
    UPDATE feedback SET confirm_wait_until = now() - interval '1 minute'
     WHERE project_id = ${projectId} AND fb_seq = ${Number(key.slice(3))}
  `);
}

/** What core tells the reporter's project's master box it is owed besides issues, as its pass reads it. */
async function owedLine(): Promise<string> {
  const res = await api(tokens.box, 'POST', '/api/devices/me/master-session/verdict', {
    projectId: own.projectId,
    runnerId: own.runnerId,
    facts: {
      restarting: null,
      terminal: true,
      standing: 'proceed',
      pane: 'absent',
      capability: null,
      serversReadable: true,
      work: { poolWaits: false, jobPanes: 0 },
      conversation: { id: null, transcript: 'absent', elsewhere: 'none' },
      placement: null,
      holding: { kind: 'nothing' },
      turn: { kind: 'ended' },
      idle: {
        noWorkForSeconds: 0,
        pane: null,
        children: { total: 0, unfinished: [], lastClosedAgoSeconds: null },
      },
      limit: { refusal: null, hooks: 'unheard', turnStartedAgoMs: null },
      nudge: { last: null, since: 'unreported' },
    },
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return (res.body as { work: { owedLine: string } }).work.owedLine;
}

/** Each owed confirm the line lists, by key, with what follows the key up to its door. */
const owedItems = (line: string) =>
  (/owes? (?:its|their) confirm \(([^)]*)\)/.exec(line)?.[1] ?? '').split('; ').filter(Boolean);
const owedKeys = (line: string) => owedItems(line).map((k) => k.split(' ')[0]);
/** The project door's item as the line lists it: keys repeat across projects, its door says which. */
const ownListed = (line: string, key: string) =>
  owedItems(line).find((i) => i.includes(`projects/${own.projectId}/feedback/${key}/verify`));

describe('the Forge door: a wait keeps a shipped item off the master’s line until its date (FB-470)', () => {
  it('leaves the line while the wait holds, shows why on the item, and returns once the date passes', async () => {
    const key = await shippedForgeItem();
    expect(owedKeys(await owedLine())).toContain(key);

    const reason = 'needs the owner’s next message in the room, which the master cannot send';
    const set = await forgeWait(tokens.master, key, { until: inDays(3), reason });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    expect(set.body).toMatchObject({
      key,
      phase: 'resolved',
      confirmWait: { until: expect.any(String), on: null, reason },
    });
    expect(owedKeys(await owedLine()), 'a waiting item leaves the line').not.toContain(key);
    const read = await api(tokens.master, 'GET', `/api/forge/feedback/${key}`);
    expect(read.body.confirmWait).toMatchObject({ reason });
    const page = await api(home.token, 'GET', `/api/projects/${home.projectId}/feedback/${key}`);
    expect(
      (page.body.feedback as Body).confirmWait,
      'the item’s page shows the wait',
    ).toMatchObject({ reason });

    await lapse(home.projectId, key);
    const back = owedItems(await owedLine()).find((i) => i.startsWith(`${key} `));
    expect(back ?? 'not listed', 'the item returns once the date passed').toContain(
      'its wait ended: its date passed',
    );
    const after = await api(tokens.master, 'GET', `/api/forge/feedback/${key}`);
    expect(after.body.confirmWait, 'a lapsed wait no longer shows').toBeNull();
  });

  it('refuses a wait with no reason by name, writing nothing', async () => {
    const key = await shippedForgeItem();
    for (const body of [{ until: inDays(3) }, { until: inDays(3), reason: '  ' }]) {
      const res = await forgeWait(tokens.master, key, body);
      expect(res.status, JSON.stringify(res.body)).toBe(422);
      const r = refusalOf(res.body);
      expect(r).toMatchObject({ code: 'FEEDBACK_CONFIRM_WAIT_REASON_REQUIRED', path: '/reason' });
      expect(r?.detail).toContain('{ until: ISO 8601 date-time within 30 days');
    }
    expect(owedKeys(await owedLine()), 'a refused wait keeps nothing off the line').toContain(key);
  });

  it('refuses an account that neither reported the item nor acts for its reporter', async () => {
    const key = await shippedForgeItem();
    const res = await forgeWait(home.token, key, { until: inDays(3), reason: 'mine to wait' });
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(refusalOf(res.body)?.code).toBe('FORGE_FEEDBACK_NOT_YOURS');
    const stranger = await forgeWait(tokens.stranger, key, { until: inDays(3), reason: 'x' });
    expect(refusalOf(stranger.body)?.code).toBe('FORGE_FEEDBACK_NOT_FOUND');
    expect(owedKeys(await owedLine())).toContain(key);
  });

  it('the verify it waited for clears the wait', async () => {
    const key = await shippedForgeItem();
    await forgeWait(tokens.master, key, { until: inDays(3), reason: 'waits on the owner' });
    const done = await api(tokens.master, 'POST', `/api/forge/feedback/${key}/verify`, {
      evidence: 'The owner wrote in the room; the reply came in the thread on the shipped build.',
    });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    const [row] = (await db.execute(sql`
      SELECT confirm_wait_until FROM feedback
       WHERE project_id = ${home.projectId} AND fb_seq = ${Number(key.slice(3))}
    `)) as unknown as { confirm_wait_until: Date | null }[];
    expect(row?.confirm_wait_until).toBeNull();
  });
});

describe('the project door: a wait on the next room message (FB-476)', () => {
  it('leaves the line until a member’s message arrives in the project’s room, then names it again', async () => {
    const key = await shippedOwnItem();
    expect(ownListed(await owedLine(), key)).toBeDefined();
    const set = await ownWait(tokens.master, key, {
      until: inDays(14),
      on: 'room_message',
      reason: 'the owner’s next message in the room tests the fix',
    });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    expect((set.body.feedback as Body).confirmWait).toMatchObject({ on: 'room_message' });
    expect(ownListed(await owedLine(), key)).toBeUndefined();

    // a message in another project's room meets nothing here
    expect(await db.transaction((tx) => meetRoomConfirmWaits(tx, home.projectId, new Date()))).toBe(
      0,
    );
    expect(ownListed(await owedLine(), key)).toBeUndefined();

    expect(await db.transaction((tx) => meetRoomConfirmWaits(tx, own.projectId, new Date()))).toBe(
      1,
    );
    const back = ownListed(await owedLine(), key);
    expect(back ?? 'not listed', 'the item returns once the message came').toContain(
      'its wait ended: the room message came',
    );
  });

  it('refuses a wait with no reason, a date past the limit, and a person’s item, by name', async () => {
    const key = await shippedOwnItem();
    const bare = await ownWait(tokens.master, key, { until: inDays(3) });
    expect(bare.status, JSON.stringify(bare.body)).toBe(422);
    expect(refusalOf(bare.body)).toMatchObject({
      code: 'FEEDBACK_CONFIRM_WAIT_REASON_REQUIRED',
      path: '/reason',
    });
    const far = await ownWait(tokens.master, key, { until: inDays(31), reason: 'later' });
    expect(refusalOf(far.body)).toMatchObject({
      code: 'FEEDBACK_CONFIRM_WAIT_TOO_FAR',
      path: '/until',
    });
    const person = await ownWait(own.token, key, { until: inDays(3), reason: 'mine' });
    expect(person.status, JSON.stringify(person.body)).toBe(403);
    expect(refusalOf(person.body)?.code).toBe('FEEDBACK_CONFIRM_WAIT_FORBIDDEN');

    // an item the agent reported whose work has not shipped owes no confirm yet
    const unshipped = await feedback(own);
    await db.execute(sql`
      UPDATE feedback SET reported_by = ${channel}, reporter_agency = 'agent'
       WHERE project_id = ${own.projectId} AND fb_seq = ${Number(unshipped.slice(3))}
    `);
    const notOwed = await ownWait(tokens.master, unshipped, { until: inDays(3), reason: 'x' });
    expect(refusalOf(notOwed.body)).toMatchObject({
      code: 'FEEDBACK_CONFIRM_WAIT_NOT_OWED',
      path: '/feedback',
    });
    expect(ownListed(await owedLine(), key)).toBeDefined();
  });
});
