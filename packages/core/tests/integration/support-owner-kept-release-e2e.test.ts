import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const decideFails = vi.hoisted(() => {
  // the bot's token is sealed in the integration vault
  process.env.INTEGRATION_MASTER_KEY ??= Buffer.alloc(32, 5).toString('base64');
  return { on: false };
});

// a fault that is no refusal, as a dropped database connection is, while deciding a release
vi.mock('../../src/release-batch/index.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/release-batch/index.js')>();
  return {
    ...real,
    decideApprovalOfVersion: (...args: Parameters<typeof real.decideApprovalOfVersion>) => {
      if (decideFails.on) throw new Error('Connection terminated unexpectedly');
      return real.decideApprovalOfVersion(...args);
    },
  };
});

import { mintPat } from '../../src/credentials/pat.js';
import { api, userToken } from '../helpers/api.js';
import { addProjectMember, createTestUser, rows } from '../helpers/factories.js';
import { approvalOf, cutAndAsk } from '../helpers/release-approval.js';
import { AgentWorld, OWNER_ID } from '../helpers/support-agent-world.js';
import { code } from '../helpers/support-channel.js';
import type { StandInRocketChat } from '../helpers/support-chat-server.js';

// @direct-test-of packages/core/src/support/release-decision.ts
// @direct-test-of packages/core/src/support/release-decide-as.ts
// @direct-test-of packages/core/src/support/kept-answers.ts
// @direct-test-of packages/core/src/support/setup-step.ts
// @direct-test-of packages/core/src/support/ops-asker.ts
// @direct-test-of packages/core/src/support/speaker-link.ts
// @direct-test-of packages/core/src/support/deciders.ts
// @direct-test-of packages/core/src/knowledge/ruling-deciders.ts
// @direct-test-of packages/core/src/release-batch/approvals.ts
// @direct-test-of packages/core/src/release-batch/draft-approval.ts
// @direct-test-of packages/core/src/agreements/represented.ts
//
// ISS-1313 (FB-730, adminhub-api 0.27.0, 2026-11-18): the owner wrote "Cái CTV cho lên prod đi nha"
// in his room, and his go reached no door: his chat account maps to no Forge account, so
// release_decision refused OPS_ASKER_UNMAPPED, naming a link he may not be asked for, and dropped
// it, where his answers to questions are kept until an admin names his account (ISS-976). His go
// is now kept the same way and decided as his once his account is named, by an account that may
// decide that release; anyone else unmapped is told the admin step that names them.

const w = new AgentWorld();
let chat: StandInRocketChat;
let slug = '';
let admin = '';
let adminId = '';
let chuong = '';
let chuongEmail = '';
let member = '';
let approvalId = '';

const NAMED = () => `/api/projects/${w.projectId}/speaker-links/named`;
const GO = 'Cái CTV cho lên prod đi nha';

/** The goes kept for the release, with what became of each. */
const keptGoes = async () =>
  rows<{ input: Record<string, unknown>; output: Record<string, unknown> | null }>(sql`
    SELECT input, output FROM support_actions
     WHERE kind = 'answer_kept' AND tool = 'release_decision' AND project_id = ${w.projectId}
     ORDER BY created_at`);

/** `who` writes `text`, and the agent cites it as their go on 0.27.0. */
async function goBy(who: typeof chat.alice, text: string) {
  let out: Record<string, unknown> = {};
  const heard = await w.hear(
    () => chat.say(who, text),
    async (_t, act, message) => {
      out = await act({
        action: 'release_decision',
        thread: String(message().thread),
        message: String(message().message),
        project: slug,
        version: '0.27.0',
        decision: 'approve',
      });
    },
  );
  return { id: heard.id, out };
}

/**
 * An admin names the owner's chat account as `userId`, with `token` (his session by default); the
 * notes the agent is then handed.
 */
async function nameOwner(userId: string, token = admin): Promise<string[]> {
  await w.settleWarm();
  const notes: string[] = [];
  w.box.model = async (turn) => {
    for (const m of turn.messages) if (m.from === 'forge') notes.push(m.text);
  };
  const named = await api(token, 'POST', NAMED(), {
    source: 'rocketchat',
    externalId: OWNER_ID,
    userId,
    reason: 'FB-730: the chat server reports no address for the owner',
  });
  expect(named.status, JSON.stringify(named.body)).toBe(201);
  return notes;
}

beforeAll(async () => {
  await w.openAgent();
  chat = w.stand;
  const [project] = await rows<{ slug: string }>(
    sql`SELECT slug FROM projects WHERE id = ${w.projectId}`,
  );
  slug = String(project?.slug);
  const a = await createTestUser({ verified: true });
  await addProjectMember(w.projectId, a.id, 'admin');
  adminId = a.id;
  admin = await userToken(a.id);
  // chuong may decide a release (admin); a member writes but holds no releases.approve
  const c = await createTestUser({ verified: true });
  chuong = c.id;
  chuongEmail = c.email;
  await addProjectMember(w.projectId, chuong, 'admin');
  member = (await createTestUser({ verified: true })).id;
  await addProjectMember(w.projectId, member, 'member');
  // the chat server reports no address for the owner's account, as adminhub-api's does
  chat.emails.delete(OWNER_ID);
  ({ approvalId } = await cutAndAsk(w.projectId, w.ownerId, '0.27.0'));
}, 120_000);

afterAll(() => w.stop());

describe("ISS-1313: an unlinked owner's go on a release is kept, and decided as his once named", () => {
  it('keeps nothing where the chat server would not say who he is, since he may be mapped', async () => {
    // his address is a Forge account's, verified: only the chat server's silence hides it
    chat.emails.set(OWNER_ID, chuongEmail);
    chat.usersInfoDown = true;
    try {
      const go = await goBy(chat.alice, GO);
      // [KEPT_ON_SILENCE] before the fix: kept, waiting on a naming no admin would ever make
      expect(code(go.out), JSON.stringify(go.out)).toBe('OPS_ASKER_UNMAPPED');
      expect(JSON.stringify(go.out)).toContain('again in a moment');
      expect(await keptGoes()).toEqual([]);
      expect(await approvalOf(approvalId)).toMatchObject({ decision: null });
    } finally {
      chat.usersInfoDown = false;
      chat.emails.delete(OWNER_ID);
    }
  });

  it('keeps his go, tells the room nothing now, and decides nothing yet', async () => {
    const go = await goBy(chat.alice, GO);
    // [GO_DROPPED] before the fix: refused OPS_ASKER_UNMAPPED and nothing kept
    expect(code(go.out), JSON.stringify(go.out)).toBeUndefined();
    expect(go.out).toMatchObject({ kept: true, version: '0.27.0', project: slug });
    const said = JSON.stringify(go.out);
    expect(said).toContain('speaker-links/named');
    expect(said).toContain('project admin');
    expect(said).toContain('instance admin');
    expect(said).toContain('Say nothing to the room now');
    expect(said).not.toContain('is noted');
    expect(said).not.toMatch(/ask (him|them) to link it|Confirm a speaker link/);
    expect(await approvalOf(approvalId)).toMatchObject({ decision: null });
    const kept = await keptGoes();
    expect(kept).toHaveLength(1);
    expect(kept[0]?.input).toMatchObject({ message: go.id, version: '0.27.0', ownerKey: OWNER_ID });
    expect(kept[0]?.output ?? null).toBeNull();
  });

  it('refuses it by name where the account named may not decide the release, deciding nothing', async () => {
    const notes = await nameOwner(member);
    await expect
      .poll(
        async () => {
          const kept = await keptGoes();
          return kept.length > 0 && kept.every((k) => k.output && !('recording' in k.output));
        },
        { timeout: 10_000 },
      )
      .toBe(true);
    for (const k of await keptGoes()) {
      expect(k.output).toMatchObject({ recorded: false });
      expect(String(k.output?.why)).toContain('releases.approve');
    }
    expect(await approvalOf(approvalId)).toMatchObject({ decision: null });
    await expect
      .poll(() => notes.some((n) => n.includes('was not recorded') && n.includes('0.27.0')), {
        timeout: 10_000,
      })
      .toBe(true);
    // the wrong naming is undone, and his next go is kept again
    const listed = await api(admin, 'GET', NAMED());
    const naming = (
      listed.body as { namings: { id: string; externalId: string; undoneAt: string | null }[] }
    ).namings.find((n) => n.externalId === OWNER_ID && !n.undoneAt);
    const undone = await api(admin, 'DELETE', `${NAMED()}/${naming?.id}`, {
      reason: 'named an account that may not decide releases',
    });
    expect(undone.status, JSON.stringify(undone.body)).toBe(200);
  });

  it('says why where deciding it fails on a fault, and tells the room, never leaving it claimed', async () => {
    const go = await goBy(chat.alice, GO);
    expect(go.out).toMatchObject({ kept: true });
    decideFails.on = true;
    try {
      const notes = await nameOwner(chuong);
      // [KEPT_GO_SPENT] before the fix: the fault escaped, the row stayed {recording: true}, untold
      await expect
        .poll(async () => (await keptGoes()).at(-1)?.output, { timeout: 10_000 })
        .toMatchObject({ recorded: false, why: 'Connection terminated unexpectedly' });
      expect(await approvalOf(approvalId)).toMatchObject({ decision: null });
      await expect
        .poll(() => notes.some((n) => n.includes('was not recorded') && n.includes(go.id)), {
          timeout: 10_000,
        })
        .toBe(true);
    } finally {
      decideFails.on = false;
    }
    const listed = await api(admin, 'GET', NAMED());
    const naming = (
      listed.body as { namings: { id: string; externalId: string; undoneAt: string | null }[] }
    ).namings.find((n) => n.externalId === OWNER_ID && !n.undoneAt);
    const undone = await api(admin, 'DELETE', `${NAMED()}/${naming?.id}`, {
      reason: 'named again once deciding works',
    });
    expect(undone.status, JSON.stringify(undone.body)).toBe(200);
  });

  it('decides it as his, citing his message, once an account that may decide it is named', async () => {
    const go = await goBy(chat.alice, GO);
    expect(go.out).toMatchObject({ kept: true });
    // named on a token whose grant holds project.admin and no releases.approve: his own role decides
    const namer = await mintPat({
      permissions: ['projects:write', 'project.admin'],
      userId: adminId,
      name: 'namer',
      projectIds: [w.projectId],
    });
    const notes = await nameOwner(chuong, namer.plaintext);
    await expect
      .poll(async () => (await approvalOf(approvalId))?.decision, { timeout: 10_000 })
      .toBe('approved');
    const stored = await approvalOf(approvalId);
    expect(stored?.decided_by_user).toBe(chuong);
    expect(stored?.reason).toContain(go.id);
    expect(stored?.reason).toContain(GO);
    const last = (await keptGoes()).at(-1);
    expect(last?.output).toMatchObject({ recorded: true, by: chuong });
    await expect
      .poll(() => notes.some((n) => n.includes('recorded as his') && n.includes(go.id)), {
        timeout: 10_000,
      })
      .toBe(true);
  });
});

// ISS-1432 (REQ-90 BC-16): an undeclared speaker's go was refused naming the admins' account naming,
// which the room relayed to the owner as "link her account"; it now asks once whether to declare them
describe("ISS-1432: an undeclared speaker's go asks once whether to declare them, never for an account", () => {
  it('refuses it by name with the one yes or no, and asks nobody to link or invite anything', async () => {
    // bob is no Forge account, no owner and not declared: his go is refused, and nothing is kept
    const before = (await keptGoes()).length;
    const bob = await goBy(chat.bob, 'cho lên 0.27.0 đi');
    // [ASKS_FOR_ACCOUNT] before the fix: OPS_ASKER_UNMAPPED naming speaker-links/named
    expect(code(bob.out), JSON.stringify(bob.out)).toBe('SUPPORT_DECIDER_NOT_DECLARED');
    const said = JSON.stringify(bob.out);
    expect(said).toContain('as a yes or no');
    expect(said).toContain("Declare @bob to decide a release's go or no here?");
    expect(said).toContain('metadata.deciders[].speaker');
    expect(said).not.toMatch(
      /speaker-links|link (her|his|their) account|names (her|his|their) Forge account/,
    );
    expect(said).toContain('Never ask anyone to link, invite or make an account for them');
    expect((await keptGoes()).length).toBe(before);
  });
});

// ISS-1432 (REQ-90 BC-15, BC-16; FB-795, sidpeak's releases held on the owner since 2026-11-20): the
// project's BA decides its releases in the room and holds no Forge account, so her go was kept until
// an admin named an account (ISS-1383) and the room asked the owner to "link her account". A project
// admin now declares her by chat identity, with the acts she decides; her go or hold in the project's
// room decides the release as that identity, with no account, no invite and no owner press.
describe('ISS-1432: a decider declared by chat identity decides the release with no Forge account', () => {
  let held = '';
  let onHold = '';
  let memberToken = '';
  const RULING = 'release-go-by-bob';

  /** The declaration, written by `token`: bob for releases, carol for reopens only. */
  const declare = (token: string, deciders: Record<string, unknown>[]) =>
    api(token, 'PUT', `/api/projects/${w.projectId}/knowledge/${RULING}`, {
      title: 'Releases go on bob’s word',
      body: 'Owner ruling: bob decides whether a release goes to production.',
      kind: 'rule',
      confidence: 'verified',
      source: 'owner ruling, ISS-1432',
      scope: 'releases of this project',
      recheckWhen: 'the owner names another release decider',
      metadata: { deciders },
    });
  const BOB = () => ({
    member: 'bob',
    speaker: { source: 'rocketchat', externalId: chat.bob.userId },
    acts: ['release'],
  });
  const CAROL = () => ({
    member: 'carol',
    speaker: { source: 'rocketchat', externalId: chat.carol.userId },
    acts: ['reopen'],
  });

  /** The decision row of an approval, with who decided it. */
  const decidedRow = async (id: string) =>
    (
      await rows<{
        decision: string | null;
        decided_by_user: string | null;
        decided_by_chat_account: string | null;
        decided_by_chat_name: string | null;
        reason: string | null;
      }>(sql`SELECT decision, decided_by_user, decided_by_chat_account, decided_by_chat_name, reason
               FROM release_approvals WHERE id = ${id}`)
    )[0];

  /** `who` writes `text`, and the agent cites it as their `decision` on `version`. */
  async function decides(
    who: typeof chat.bob,
    text: string,
    version: string,
    decision: 'approve' | 'return' = 'approve',
  ) {
    let out: Record<string, unknown> = {};
    const heard = await w.hear(
      () => chat.say(who, text),
      async (_t, act, message) => {
        out = await act({
          action: 'release_decision',
          thread: String(message().thread),
          message: String(message().message),
          project: slug,
          version,
          decision,
          ...(decision === 'return' ? { reason: 'giữ lại, chưa test xong' } : {}),
        });
      },
    );
    return { id: heard.id, out, turn: heard.turn };
  }

  beforeAll(async () => {
    memberToken = await userToken(member);
    ({ approvalId: held } = await cutAndAsk(w.projectId, w.ownerId, '0.28.0'));
    ({ approvalId: onHold } = await cutAndAsk(w.projectId, w.ownerId, '0.29.0'));
  });

  it('refuses a declaration by a member who is no project admin, by name, storing nothing', async () => {
    const put = await declare(memberToken, [BOB()]);
    // [DECLARED_BY_ANYONE] before the fix: a speaker was unknown to the door, refused only as a shape
    expect(put.status, JSON.stringify(put.body)).toBe(422);
    expect(JSON.stringify(put.body)).toContain('KNOWLEDGE_DECLARATION_NOT_ADMIN');
    expect(JSON.stringify(put.body)).toContain('project.admin');
    expect(
      await rows(
        sql`SELECT 1 FROM knowledge_entries WHERE project_id = ${w.projectId}::uuid AND slug = ${RULING}`,
      ),
    ).toEqual([]);
  });

  it('refuses a reopen named by username alone: it is declared by chat identity', async () => {
    const put = await declare(admin, [{ member: 'carol', acts: ['reopen'] }]);
    expect(put.status, JSON.stringify(put.body)).toBe(422);
    expect(JSON.stringify(put.body)).toContain('KNOWLEDGE_DECIDERS_SHAPE');
    expect(JSON.stringify(put.body)).toContain('declared by chat identity');
  });

  it('takes an admin’s declaration with no Forge account or invite, and shows it with the deciders', async () => {
    const put = await declare(admin, [BOB(), CAROL()]);
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    // no Forge account was made or invited for either
    expect(await rows(sql`SELECT 1 FROM users WHERE display_name IN ('bob', 'carol')`)).toEqual([]);
    const read = await api(admin, 'GET', `/api/projects/${w.projectId}/agreements`);
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    const said = JSON.stringify(read.body);
    expect(said).toContain("@bob, by chat identity, decides a release's go or no");
    expect(said).toContain("@carol, by chat identity, decides an issue's reopen or status move");
    expect(said).not.toContain(chat.bob.userId);
  });

  it('approves the release on her go in the project’s room, as her chat identity, with no owner press', async () => {
    const go = await decides(chat.bob, 'Ok cho lên 0.28.0 nhé', '0.28.0');
    // [DECIDER_KEPT] before the fix: kept until an admin named an account, the release held
    expect(code(go.out), JSON.stringify(go.out)).toBeUndefined();
    expect(go.out).toMatchObject({
      decision: 'approve',
      version: '0.28.0',
      decidedBy: '@bob',
      declaredBy: `knowledge:${RULING}`,
    });
    const row = await decidedRow(held);
    expect(row).toMatchObject({
      decision: 'approved',
      decided_by_user: null,
      decided_by_chat_name: '@bob',
    });
    const [account] = await rows<{ id: string; external_id: string }>(
      sql`SELECT id, external_id FROM chat_temporary_accounts WHERE id = ${row?.decided_by_chat_account}::uuid`,
    );
    expect(account?.external_id).toBe(chat.bob.userId);
    expect(row?.reason).toContain(go.id);
    expect(row?.reason).toContain('Ok cho lên 0.28.0 nhé');
    expect(row?.reason).toContain(`knowledge:${RULING}`);
    // the room's brief says what her word does, and never to ask for an account
    expect(go.turn.text).toContain("@bob, by chat identity, decides a release's go or no");
    expect(go.turn.text).toContain('Never ask anyone to link, invite or make an account for them');
    // nothing was kept for an account to come
    expect((await keptGoes()).filter((k) => k.input.version === '0.28.0')).toEqual([]);
  });

  it('records her hold as hers, the release returned with her why', async () => {
    const hold = await decides(chat.bob, 'Khoan, giữ 0.29.0 lại', '0.29.0', 'return');
    expect(code(hold.out), JSON.stringify(hold.out)).toBeUndefined();
    expect(await decidedRow(onHold)).toMatchObject({
      decision: 'returned',
      decided_by_user: null,
      decided_by_chat_name: '@bob',
    });
    expect((await decidedRow(onHold))?.reason).toContain('giữ lại, chưa test xong');
  });

  it('refuses a go on a release her declaration does not cover, by name, deciding nothing', async () => {
    const { approvalId } = await cutAndAsk(w.projectId, w.ownerId, '0.30.0');
    const go = await decides(chat.carol, 'cho lên 0.30.0 luôn', '0.30.0');
    expect(code(go.out), JSON.stringify(go.out)).toBe('SUPPORT_DECIDER_ACT_NOT_DECLARED');
    const said = JSON.stringify(go.out);
    expect(said).toContain("an issue's reopen or status move");
    expect(said).toContain('yes or no');
    expect(said).not.toMatch(/speaker-links|link (her|his|their) account/);
    expect(await decidedRow(approvalId)).toMatchObject({ decision: null });
  });
});
