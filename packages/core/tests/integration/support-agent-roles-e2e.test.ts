import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.INTEGRATION_MASTER_KEY ??= Buffer.alloc(32, 5).toString('base64');
});

import { mintPat } from '../../src/credentials/pat.js';
import { db } from '../../src/db/client.js';
import { withKernelMarker } from '../../src/db/kernel-marker.js';
import { ensureMasterSession } from '../../src/devices/index.js';
import { api } from '../helpers/api.js';
import {
  addProjectMember,
  bindTestRunner,
  createTestDevice,
  createTestIssue,
  createTestUser,
  rows,
} from '../helpers/factories.js';
import { SupportWorld } from '../helpers/support-world.js';

// REQ-75 r7 (ISS-751 c9..c13): a project lists its agent sessions by role, each with its box and the
// address it is reached at now, and a peer finds another by role from that list. A master is read
// off the session Forge placed, so its restart moves the address; an agent outside Forge (Babo on a
// group a binding names in `outsideRids`) declares itself on its channel, again on each restart.
// Talk between two sessions is theirs to record or not, and nothing in Forge refuses it unrecorded;
// an owner question an agent put on Forge can be answered from the channel, written back by the
// channel agent through the questions door. The world is support-room-e2e's, never bound to a
// Forge session.

const w = new SupportWorld();
const OUTSIDE = 'GROUP-WEBMAIL';
const FORGE_ANSWERED = 'GROUP-TEAM';
const ROLE = 'webmail Babo';

let baboToken = '';
let deviceId = '';

const base = () => `/api/projects/${w.projectId}`;
const pat = async (userId: string, name: string, permissions: string[]) =>
  (
    await mintPat({
      userId,
      name,
      permissions: permissions as never,
      projectIds: [w.projectId],
    })
  ).plaintext;

/** A request on the served core with a token, as an agent on its box sends it. */
async function call(token: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${w.core.base}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : {}) as Record<string, unknown> };
}

type Role = { kind: string; role: string; channel: string | null; address: string; box: string };
const lookup = async (token: string, role?: string) => {
  const q = role === undefined ? '' : `?role=${encodeURIComponent(role)}`;
  const got = await call(token, 'GET', `${base()}/agent-roles${q}`);
  expect(got.status, JSON.stringify(got.body)).toBe(200);
  return got.body.sessions as Role[];
};

beforeAll(async () => {
  await w.start();
  const rc = await api(w.owner, 'POST', '/api/integration-connections', {
    provider: 'rocketchat',
    displayName: 'Mail bot',
    config: { serverUrl: w.chat.serverUrl },
    secrets: { authToken: w.chat.bot.authToken, userId: w.chat.bot.userId },
    bindings: [
      {
        projectId: w.projectId,
        role: 'service',
        target: { provider: 'rocketchat', rids: [FORGE_ANSWERED], outsideRids: [OUTSIDE] },
      },
    ],
  });
  expect(rc.status, JSON.stringify(rc.body)).toBe(201);
  // Babo's own Forge account: a member of the project with its own token
  const babo = await createTestUser({ verified: true });
  await addProjectMember(w.projectId, babo.id, 'member');
  baboToken = await pat(babo.id, 'babo', [
    'projects:read',
    'projects:write',
    'questions:read',
    'questions:write',
  ]);
  deviceId = await createTestDevice(w.ownerId, { name: 'box-a' });
  await bindTestRunner(w.projectId, deviceId);
}, 120_000);

afterAll(() => w.stop());

describe('REQ-75 r7: a channel names the agent answering it (BC-42)', () => {
  it('an outside agent declares its role, box and address on its group, and the record names it', async () => {
    const put = await call(baboToken, 'PUT', `${base()}/support/channels/${OUTSIDE}/agent`, {
      role: ROLE,
      box: 'mail-box',
      address: 'tmux:babo-watch',
    });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    const read = await call(baboToken, 'GET', `${base()}/support/channels/${OUTSIDE}`);
    expect((read.body.channel as { agent: unknown }).agent).toMatchObject({
      kind: 'channel',
      role: ROLE,
      channel: OUTSIDE,
      answeredBy: 'outside',
      box: 'mail-box',
      address: 'tmux:babo-watch',
    });
  });

  it('refuses a declaration on a group Forge answers, one no binding names, and one carrying a secret', async () => {
    const body = { role: ROLE, box: 'mail-box', address: 'tmux:babo-watch' };
    const forge = await call(
      baboToken,
      'PUT',
      `${base()}/support/channels/${FORGE_ANSWERED}/agent`,
      body,
    );
    expect(forge.status).toBe(409);
    expect(JSON.stringify(forge.body)).toContain('SUPPORT_CHANNEL_NOT_OUTSIDE');
    const unbound = await call(
      baboToken,
      'PUT',
      `${base()}/support/channels/GROUP-NONE/agent`,
      body,
    );
    expect(unbound.status).toBe(404);
    expect(JSON.stringify(unbound.body)).toContain('SUPPORT_CHANNEL_UNKNOWN');
    const secret = await call(baboToken, 'PUT', `${base()}/support/channels/${OUTSIDE}/agent`, {
      ...body,
      address: `tmux:babo?token=github_pat_${'A1b2C3d4'.repeat(4)}`,
    });
    expect(secret.status).toBe(400);
    expect(JSON.stringify(secret.body)).toContain('SUPPORT_CHANNEL_PRIVATE_DATA');
    // a reader may not declare an agent
    const viewer = await createTestUser({ verified: true });
    await addProjectMember(w.projectId, viewer.id, 'viewer');
    const reader = await pat(viewer.id, 'reader', ['projects:read']);
    const read = await call(reader, 'PUT', `${base()}/support/channels/${OUTSIDE}/agent`, body);
    expect(read.status).toBe(403);
    expect((await lookup(baboToken, ROLE))[0]?.address).toBe('tmux:babo-watch');
  });
});

describe('REQ-75 r7: agent sessions listed by role, found by role after a restart (BC-43, BC-44)', () => {
  let firstMaster = '';

  it('lists the live master and the channel agent, each with its box and live address', async () => {
    firstMaster = (
      await ensureMasterSession({ deviceId, projectId: w.projectId, name: 'forge-master' })
    ).sessionId;
    const all = await lookup(baboToken);
    expect(all).toEqual([
      expect.objectContaining({
        kind: 'master',
        role: 'master',
        channel: null,
        answeredBy: 'forge',
        box: 'box-a',
        address: `forge-session:${firstMaster}`,
        terminal: 'forge-master',
      }),
      expect.objectContaining({ kind: 'channel', role: ROLE, channel: OUTSIDE }),
    ]);
  });

  it('after a master restarts at a new address, the lookup by its role returns the new one, never the old', async () => {
    // the box restarts: its master session ends, as the kernel ends it, and a new one is placed
    await withKernelMarker(db, (tx) =>
      tx.execute(
        sql`UPDATE agent_sessions SET status = 'completed' WHERE id = ${firstMaster}::uuid`,
      ),
    );
    const next = (
      await ensureMasterSession({ deviceId, projectId: w.projectId, name: 'forge-master' })
    ).sessionId;
    expect(next).not.toBe(firstMaster);
    const found = await lookup(baboToken, 'master');
    expect(found.map((s) => s.address)).toEqual([`forge-session:${next}`]);
  });

  it('after the outside agent restarts and declares its new address, the lookup by role returns it', async () => {
    const put = await call(baboToken, 'PUT', `${base()}/support/channels/${OUTSIDE}/agent`, {
      role: ROLE,
      box: 'mail-box-2',
      address: 'tmux:babo-watch-2',
    });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    const found = await lookup(baboToken, 'WEBMAIL babo');
    expect(found).toEqual([
      expect.objectContaining({ role: ROLE, box: 'mail-box-2', address: 'tmux:babo-watch-2' }),
    ]);
    expect(await lookup(baboToken, 'nobody')).toEqual([]);
  });
});

describe('REQ-75 r7: talk between sessions is theirs to record (BC-45)', () => {
  it('two sessions find each other by role and talk with nothing recorded, and nothing in Forge refuses either', async () => {
    const count = async () =>
      (
        await rows<{ n: number }>(sql`
          SELECT (SELECT count(*) FROM agent_questions WHERE project_id = ${w.projectId}::uuid)
               + (SELECT count(*) FROM comments c JOIN issues i ON i.id = c.issue_id WHERE i.project_id = ${w.projectId}::uuid)
               + (SELECT count(*) FROM memories WHERE project_id = ${w.projectId}::uuid)
               + (SELECT count(*) FROM support_actions a JOIN support_rooms r ON r.id = a.room_id WHERE r.project_id = ${w.projectId}::uuid)
               AS n`)
      )[0]?.n;
    const before = await count();
    const masterToken = await pat(w.ownerId, 'master', ['projects:read', 'projects:write']);
    const babo = (await lookup(masterToken, ROLE))[0];
    const master = (await lookup(baboToken, 'master'))[0];
    expect(babo?.address).toBe('tmux:babo-watch-2');
    expect(master?.address).toMatch(/^forge-session:/);
    // the exchange itself runs between the two, on their boxes; each goes on with its work in Forge
    const declared = await call(baboToken, 'PUT', `${base()}/support/channels/${OUTSIDE}/agent`, {
      role: ROLE,
      box: 'mail-box-2',
      address: 'tmux:babo-watch-2',
    });
    expect(declared.status, JSON.stringify(declared.body)).toBe(200);
    const read = await call(masterToken, 'GET', `${base()}/support/channels/${OUTSIDE}`);
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    expect(await lookup(masterToken, ROLE)).toHaveLength(1);
    expect(await count()).toBe(before);
  });
});

describe('REQ-75 r7: an owner question answered from the channel (BC-46)', () => {
  let seq = 0;
  // the agent's work the question is asked on: an issue in progress
  const ask = async (token: string, prompt: string) =>
    call(token, 'POST', '/api/questions', {
      issueId: (
        await createTestIssue(w.projectId, w.ownerId, ++seq, {
          status: 'in_progress',
          createdAt: new Date(),
        })
      ).id,
      prompt,
      options: [
        { id: 'yes', label: 'Yes', authority: 'writer', bindsTo: 'project', executedBy: 'agent' },
        { id: 'no', label: 'No', authority: 'writer', bindsTo: 'project', executedBy: 'agent' },
      ],
      recommendedOptionId: 'yes',
    });

  it('the channel agent writes the owner’s channel answer back through the questions door', async () => {
    const asked = await ask(baboToken, 'May I move the mail queue to the new node tonight?');
    expect(asked.status, JSON.stringify(asked.body)).toBe(201);
    const id = String(asked.body.id);
    const round = Number((asked.body as { round?: number }).round ?? 1);
    // the owner answered in #webmail; Babo writes it back with the token the owner gave it
    const relay = await pat(w.ownerId, 'babo-relay', ['questions:read', 'questions:write']);
    const answered = await call(relay, 'POST', `/api/questions/${id}/answer`, {
      round,
      optionId: 'yes',
    });
    expect(answered.status, JSON.stringify(answered.body)).toBe(200);
    const seen = await call(baboToken, 'GET', `/api/questions/${id}`);
    const [step] = (seen.body as { steps: Record<string, unknown>[] }).steps;
    // the owner's word, carried by the token the owner gave the channel agent
    expect(seen.body).toMatchObject({ status: 'answered' });
    expect(step).toMatchObject({ chosenOptionId: 'yes', answeredBy: w.ownerId });
    const [token] = await rows<{ name: string }>(sql`
      SELECT name FROM personal_access_tokens WHERE id = ${String((step?.answeredWith as { tokenId?: string } | undefined)?.tokenId)}::uuid`);
    expect(token?.name).toBe('babo-relay');
  });

  it('is never the only way: the owner answers on Forge as before', async () => {
    const asked = await ask(baboToken, 'Shall I rotate the webmail certificate?');
    expect(asked.status, JSON.stringify(asked.body)).toBe(201);
    const id = String(asked.body.id);
    const round = Number((asked.body as { round?: number }).round ?? 1);
    const direct = await api(w.owner, 'POST', `/api/questions/${id}/answer`, {
      round,
      optionId: 'no',
    });
    expect(direct.status, JSON.stringify(direct.body)).toBe(200);
  });
});
