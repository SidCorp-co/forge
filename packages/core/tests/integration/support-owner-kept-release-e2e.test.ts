import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  // the bot's token is sealed in the integration vault
  process.env.INTEGRATION_MASTER_KEY ??= Buffer.alloc(32, 5).toString('base64');
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
  chuong = (await createTestUser({ verified: true })).id;
  await addProjectMember(w.projectId, chuong, 'admin');
  member = (await createTestUser({ verified: true })).id;
  await addProjectMember(w.projectId, member, 'member');
  // the chat server reports no address for the owner's account, as adminhub-api's does
  chat.emails.delete(OWNER_ID);
  ({ approvalId } = await cutAndAsk(w.projectId, w.ownerId, '0.27.0'));
}, 120_000);

afterAll(() => w.stop());

describe("ISS-1313: an unlinked owner's go on a release is kept, and decided as his once named", () => {
  it('keeps his go, tells the room it waits on an admin step, and decides nothing yet', async () => {
    const go = await goBy(chat.alice, GO);
    // [GO_DROPPED] before the fix: refused OPS_ASKER_UNMAPPED and nothing kept
    expect(code(go.out), JSON.stringify(go.out)).toBeUndefined();
    expect(go.out).toMatchObject({ kept: true, version: '0.27.0', project: slug });
    const said = JSON.stringify(go.out);
    expect(said).toContain('speaker-links/named');
    expect(said).toContain('project admin');
    expect(said).toContain('instance admin');
    expect(said).toContain('noted');
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

describe("ISS-1313: an unmapped member's refusal names the admin step, never a link to ask for", () => {
  it('names speaker-links/named and who holds it, and asks nobody to link anything', async () => {
    // bob is no Forge account and no owner: his go is refused, and nothing is kept
    const before = (await keptGoes()).length;
    const bob = await goBy(chat.bob, 'cho lên 0.27.0 đi');
    expect(code(bob.out), JSON.stringify(bob.out)).toBe('OPS_ASKER_UNMAPPED');
    const said = JSON.stringify(bob.out);
    expect(said).toContain(`/api/projects/${w.projectId}/speaker-links/named`);
    expect(said).toContain('project admin');
    expect(said).toContain('instance admin');
    expect(said).toContain('/api/speaker-links/named');
    expect(said).not.toMatch(/Confirm a speaker link|give it on the chat server/);
    expect(said).toMatch(/never ask the owner to link anything/i);
    expect((await keptGoes()).length).toBe(before);
  });
});
