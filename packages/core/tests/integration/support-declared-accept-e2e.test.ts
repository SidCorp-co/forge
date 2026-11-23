import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  // the bot's token is sealed in the integration vault
  process.env.INTEGRATION_MASTER_KEY ??= Buffer.alloc(32, 5).toString('base64');
});

import { tellSpeakerLinked } from '../../src/assistant/identity/speaker-link.js';
import { db } from '../../src/db/client.js';
import { withKernelMarker } from '../../src/db/kernel-marker.js';
import { api, userToken } from '../helpers/api.js';
import {
  addProjectMember,
  createTestRequirement,
  createTestUser,
  rows,
} from '../helpers/factories.js';
import { AgentWorld } from '../helpers/support-agent-world.js';
import { code } from '../helpers/support-channel.js';
import type { StandInRocketChat } from '../helpers/support-chat-server.js';

// @direct-test-of packages/core/src/support/declared-accept.ts
// @direct-test-of packages/core/src/support/owner-forge-act.ts
// @direct-test-of packages/core/src/support/speaker-link.ts
// @direct-test-of packages/core/src/support/temporary-account.ts
// @direct-test-of packages/core/src/requirements/declared-accept.ts
// @direct-test-of packages/core/src/requirements/declared-accepter.ts
// @direct-test-of packages/core/src/requirements/agree.ts
// @direct-test-of packages/core/src/requirements/history-entries.ts
//
// ISS-1436 (REQ-90 BC-15, BC-16; moved out of ISS-1432 c2): a project admin can declare a speaker by
// chat identity with `accept` among their acts, and nothing honoured it: a requirement revision's
// acceptance in the room went only through the owner's act, refused for anyone else, and the
// acceptance recorded a Forge user, which a declared speaker does not have. Their acceptance is now
// recorded under their chat identity, with their message and thread, and moves to their user once
// their account is named; an undeclared speaker, or one declared for other acts, is refused by name
// with the one yes or no on declaring them.

const w = new AgentWorld();
let chat: StandInRocketChat;
let slug = '';
let chuong = '';

/** `who` writes `text`; the session asks for `args` as an owner_forge_act, citing that message. */
async function askBy(who: typeof chat.alice, text: string, args: Record<string, unknown>) {
  let out: Record<string, unknown> = {};
  const heard = await w.hear(
    () => chat.say(who, text),
    async (_t, act, message) => {
      out = await act({
        action: 'owner_forge_act',
        thread: String(message().thread),
        message: String(message().message),
        project: slug,
        ...args,
      });
    },
  );
  return { id: heard.id, thread: heard.message.thread, out };
}

beforeAll(async () => {
  await w.openAgent();
  chat = w.stand;
  const [project] = await rows<{ slug: string }>(
    sql`SELECT slug FROM projects WHERE id = ${w.projectId}`,
  );
  slug = String(project?.slug);
  // alice, the owner the binding names, is chuong in Forge, an admin; carol holds no account
  chuong = (await createTestUser({ verified: true })).id;
  await addProjectMember(w.projectId, chuong, 'admin');
  await db.execute(sql`
    INSERT INTO assistant_speaker_links (source, external_namespace, external_id, external_label, user_id, confirmed_via)
    VALUES ('rocketchat', ${new URL(chat.serverUrl).host}, ${chat.alice.userId}, ${chat.alice.username}, ${chuong}, 'channel_email_match')`);
}, 120_000);

afterAll(async () => {
  await w.stop();
});

describe('ISS-1436: a speaker declared by chat identity for accept accepts a requirement revision', () => {
  const RULING = 'requirement-accept-by-carol';
  let admin = '';
  let carolUser = '';

  /** Requirement `seq` with a proposed revision to accept: a draft's first, or an agreed one's second. */
  async function proposedOn(seq: number, agreed: boolean): Promise<void> {
    const { id } = await createTestRequirement(w.projectId, seq, `Requirement ${seq}`);
    const next = agreed ? 2 : 1;
    await withKernelMarker(db, async (tx) => {
      if (agreed) {
        await tx.execute(sql`
          INSERT INTO requirement_revisions (requirement_id, revision, state, spec, reason, author_id, author_agency, decided_by, decided_at)
          VALUES (${id}, 1, 'current', '{}'::jsonb, 'first cut', ${w.ownerId}, 'human', ${w.ownerId}, now())`);
        await tx.execute(sql`
          INSERT INTO requirement_baselines (requirement_id, revision, agreed_by, reason)
          VALUES (${id}, 1, ${w.ownerId}, 'agreed first')`);
        await tx.execute(
          sql`UPDATE requirements SET current_revision = 1, status = 'agreed' WHERE id = ${id}`,
        );
      }
      await tx.execute(sql`
        INSERT INTO requirement_revisions (requirement_id, revision, state, base_revision, spec, reason, author_id, author_agency, proposed_by, proposed_at)
        VALUES (${id}, ${next}, 'proposed', ${agreed ? 1 : null}, '{}'::jsonb, 'a change asked', ${w.ownerId}, 'human', ${w.ownerId}, now())`);
    });
  }

  /** The revision `revision` of requirement `seq`, with who decided it. */
  const revisionOf = async (seq: number, revision: number) =>
    (
      await rows<{
        state: string;
        decided_by: string | null;
        decided_by_chat_account: string | null;
        decided_by_chat_name: string | null;
        accept_reason: string | null;
      }>(sql`
        SELECT rr.state, rr.decided_by, rr.decided_by_chat_account, rr.decided_by_chat_name, rr.accept_reason
          FROM requirement_revisions rr JOIN requirements r ON r.id = rr.requirement_id
         WHERE r.project_id = ${w.projectId} AND r.req_seq = ${seq} AND rr.revision = ${revision}`)
    )[0];

  const declare = (acts: string[]) =>
    api(admin, 'PUT', `/api/projects/${w.projectId}/knowledge/${RULING}`, {
      title: 'Carol accepts requirements',
      body: 'Owner ruling: carol, the BA, accepts requirement revisions in the room.',
      kind: 'rule',
      confidence: 'verified',
      source: 'owner ruling, ISS-1436',
      scope: 'requirements of this project',
      recheckWhen: 'the owner names another acceptor',
      metadata: {
        deciders: [
          {
            member: 'carol',
            speaker: { source: 'rocketchat', externalId: chat.carol.userId },
            acts,
          },
        ],
      },
    });

  const accept = (seq: number) => ({
    act: 'requirement.accept',
    item: `REQ-${seq}`,
    reason: 'đọc kỹ rồi, đúng ý',
  });

  beforeAll(async () => {
    admin = await userToken(chuong);
    carolUser = (await createTestUser({ verified: true })).id;
    await addProjectMember(w.projectId, carolUser, 'member');
    await proposedOn(811, false);
    await proposedOn(812, false);
    await proposedOn(813, true);
  });

  it('refuses an undeclared speaker by name, with the one yes or no, accepting nothing', async () => {
    const carol = await askBy(chat.carol, 'Chị duyệt REQ-811 nhé', accept(811));
    // [OWNER_ONLY] before the fix: SUPPORT_FORGE_ACT_NOT_THE_OWNER, with no ask on declaring her
    expect(code(carol.out), JSON.stringify(carol.out)).toBe('SUPPORT_DECIDER_NOT_DECLARED');
    const said = JSON.stringify(carol.out);
    expect(said).toContain('as a yes or no');
    expect(said).toContain('Declare @carol to decide accepting a requirement here?');
    expect(said).toContain('metadata.deciders[].speaker');
    expect(said).not.toMatch(/speaker-links|link (her|his|their) account/);
    expect(await revisionOf(811, 1)).toMatchObject({ state: 'proposed', decided_by: null });
  });

  it('refuses a speaker declared for other acts by name, accepting nothing', async () => {
    const put = await declare(['reopen']);
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    const carol = await askBy(chat.carol, 'Chị duyệt REQ-811 nhé', accept(811));
    // [ACT_UNCHECKED] before the fix: SUPPORT_FORGE_ACT_NOT_THE_OWNER, whatever she was declared for
    expect(code(carol.out), JSON.stringify(carol.out)).toBe('SUPPORT_DECIDER_ACT_NOT_DECLARED');
    const said = JSON.stringify(carol.out);
    expect(said).toContain("an issue's reopen or status move");
    expect(said).toContain('yes or no');
    expect(await revisionOf(811, 1)).toMatchObject({ state: 'proposed', decided_by: null });
  });

  it('accepts as her chat identity where her declaration covers accept, citing her message', async () => {
    const put = await declare(['accept', 'reopen']);
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    const carol = await askBy(chat.carol, 'Chị duyệt REQ-811 nhé, đúng ý rồi', accept(811));
    // [ACCEPT_UNHONOURED] before the fix: refused, the revision left proposed
    expect(code(carol.out), JSON.stringify(carol.out)).toBeUndefined();
    expect(carol.out).toMatchObject({
      act: 'requirement.accept',
      key: 'REQ-811',
      project: slug,
      madeBy: '@carol',
      declaredBy: `knowledge:${RULING}`,
    });
    const row = await revisionOf(811, 1);
    expect(row).toMatchObject({
      state: 'current',
      decided_by: null,
      decided_by_chat_name: '@carol',
    });
    const [account] = await rows<{ external_id: string }>(
      sql`SELECT external_id FROM chat_temporary_accounts WHERE id = ${row?.decided_by_chat_account}::uuid`,
    );
    expect(account?.external_id).toBe(chat.carol.userId);
    expect(row?.accept_reason).toContain(carol.id);
    expect(row?.accept_reason).toContain(carol.thread);
    expect(row?.accept_reason).toContain('Chị duyệt REQ-811 nhé, đúng ý rồi');
    expect(row?.accept_reason).toContain(`knowledge:${RULING}`);
    // the requirement reads it as hers, by the name the room showed
    const read = await api(admin, 'GET', `/api/projects/${w.projectId}/requirements/REQ-811`);
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    const body = read.body as {
      revisions: { revision: number; decidedByName: string }[];
      history: { id: string; who: string }[];
    };
    expect(body.revisions.find((r) => r.revision === 1)?.decidedByName).toBe('@carol');
    expect(body.history.find((e) => e.id === 'rev-1-accepted')?.who).toContain('@carol');
    // no Forge account was made or asked for
    expect(await rows(sql`SELECT 1 FROM users WHERE display_name = 'carol'`)).toEqual([]);
  });

  it('re-agrees an agreed requirement on her accept, its baseline hers by chat identity', async () => {
    const carol = await askBy(chat.carol, 'REQ-813 bản 2 ok', accept(813));
    expect(code(carol.out), JSON.stringify(carol.out)).toBeUndefined();
    expect(await revisionOf(813, 2)).toMatchObject({
      state: 'current',
      decided_by: null,
      decided_by_chat_name: '@carol',
    });
    const [baseline] = await rows<{
      agreed_by: string | null;
      agreed_by_chat_name: string | null;
    }>(sql`
      SELECT b.agreed_by, b.agreed_by_chat_name FROM requirement_baselines b
        JOIN requirements r ON r.id = b.requirement_id
       WHERE r.project_id = ${w.projectId} AND r.req_seq = 813 AND b.revision = 2`);
    expect(baseline).toEqual({ agreed_by: null, agreed_by_chat_name: '@carol' });
  });

  it('moves her acceptances to her user once she links an account', async () => {
    // a baseline stays insert-only: no user but the one her identity links to may be written on it
    await expect(
      db.execute(sql`
        UPDATE requirement_baselines b SET agreed_by = ${chuong} FROM requirements r
         WHERE r.id = b.requirement_id AND r.project_id = ${w.projectId} AND r.req_seq = 813 AND b.revision = 2`),
    ).rejects.toMatchObject({ cause: { message: expect.stringContaining('BASELINE_IMMUTABLE') } });
    // her link confirmed, as the link page confirms one and tells the rooms
    const namespace = new URL(chat.serverUrl).host;
    await db.execute(sql`
      INSERT INTO assistant_speaker_links (source, external_namespace, external_id, external_label, user_id, confirmed_via)
      VALUES ('rocketchat', ${namespace}, ${chat.carol.userId}, 'carol', ${carolUser}, 'channel_email_match')`);
    await tellSpeakerLinked({
      source: 'rocketchat',
      namespace,
      externalId: chat.carol.userId,
      label: 'carol',
      userId: carolUser,
    });
    // [STAYS_UNNAMED] before the fix: nothing moved a chat identity's acceptance to its user
    await expect
      .poll(async () => (await revisionOf(811, 1))?.decided_by, { timeout: 10_000 })
      .toBe(carolUser);
    expect(await revisionOf(811, 1)).toMatchObject({ decided_by_chat_name: '@carol' });
    expect(await revisionOf(813, 2)).toMatchObject({ decided_by: carolUser });
    const [baseline] = await rows<{ agreed_by: string | null }>(sql`
      SELECT b.agreed_by FROM requirement_baselines b JOIN requirements r ON r.id = b.requirement_id
       WHERE r.project_id = ${w.projectId} AND r.req_seq = 813 AND b.revision = 2`);
    expect(baseline?.agreed_by).toBe(carolUser);
    // once linked, her accept is still by the declaration, recorded as her user beside her identity
    const later = await askBy(chat.carol, 'REQ-812 cũng ok', accept(812));
    expect(code(later.out), JSON.stringify(later.out)).toBeUndefined();
    expect(await revisionOf(812, 1)).toMatchObject({ state: 'current', decided_by: carolUser });
  });
});
