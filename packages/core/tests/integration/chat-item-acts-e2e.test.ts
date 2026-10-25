/**
 * REQ-69 BC-3, BC-5, BC-6, BC-7, BC-10 (ISS-692): asked in chat for a Product act on a requirement,
 * a feedback item, a design or a release, the assistant offers a card the person presses, never a
 * redirect. Core reads the item as the asker before offering, so a card is offered only for an act
 * the item's state allows and the asker may take; the text it would save is checked against the
 * project's language; a triage that would file an issue is refused. Pressing it is the item page's
 * own route under the asker's own token. Against real Postgres.
 *
 * @direct-test-of packages/core/src/assistant/tools/item-act-plans.ts
 * @direct-test-of packages/core/src/assistant/agreement/held-language.ts
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';

const { db } = await import('../../src/db/client.js');

const { buildOfferItemActToolset } = await import(
  '../../src/assistant/tools/offer-item-act-tool.js'
);
const { heldLanguageRefusal } = await import('../../src/assistant/agreement/held-language.js');
const { loadPageItem } = await import('../../src/assistant/page-item.js');
const { provideNeedsYouDecisionRead } = await import('../../src/assistant/index.js');
const { api, userToken } = await import('../helpers/api.js');
const { addProjectMember, createTestFeedback, createTestProject, createTestUser, makeAgreeReady } =
  await import('../helpers/factories.js');
const { seedProjectDocument } = await import('../helpers/release-world.js');

type Res = { status: number; body: Record<string, unknown> };
type Said = { offer?: Record<string, unknown>; said?: string; refused?: string };

let projectId = '';
let owner = '';
let ownerToken = '';
let member = '';

const on = (token: string, method: 'GET' | 'POST', path: string, body?: unknown) =>
  api(token, method, `/api/projects/${projectId}${path}`, body) as Promise<Res>;

async function offer(
  userId: string,
  args: Record<string, unknown>,
  project = projectId,
): Promise<Said> {
  const tools = buildOfferItemActToolset({ projectId: project, userId });
  const result = await tools.execute('offer_item_act', JSON.stringify(args));
  const text = result.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
  if (result.isError) return { refused: (JSON.parse(text) as { error: string }).error };
  return JSON.parse(text) as Said;
}

/** `REQ-n` as its author left it: a draft holding a draft revision 1 whose ready answers are in. */
async function readyDraft(title: string): Promise<string> {
  const made = await on(ownerToken, 'POST', '/requirements', {
    title,
    reason: 'planted',
    criteria: [{ body: 'A nurse sees the reminder' }, { body: 'A patient can opt out' }],
  });
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  const key = String(made.body.key);
  await makeAgreeReady(projectId, Number(key.slice(4)), owner);
  return key;
}

beforeAll(async () => {
  owner = (await createTestUser({ verified: true })).id;
  ownerToken = await userToken(owner);
  projectId = (await createTestProject(owner)).id;
  member = (await createTestUser({ verified: true })).id;
  await addProjectMember(projectId, member, 'member');
});

describe('a requirement act asked for in chat is a card the asker may press', () => {
  it('walks a draft through propose, accept and agree, each offered only from the state that allows it', async () => {
    const key = await readyDraft('Reminders reach the nurse');
    const propose = await offer(owner, { act: 'requirement.propose', key });
    expect(propose.offer).toMatchObject({
      act: 'requirement.propose',
      key,
      ref: key,
      from: 'draft',
      revision: 1,
    });
    expect(propose.said).toBe(`Pressing it proposes ${key} revision 1 to its signer.`);
    expect((await offer(owner, { act: 'requirement.accept', key })).refused).toMatch(
      new RegExp(
        `^ITEM_ACT_NOT_FROM_STATE: ${key} is draft, and requirement.accept applies to a requirement with a proposed revision`,
      ),
    );

    // the press is the requirement page's own route, under the presser's token
    expect(
      (await on(ownerToken, 'POST', `/requirements/${key}/revisions/1/propose`, {})).status,
    ).toBe(200);
    expect((await offer(owner, { act: 'requirement.accept', key })).offer).toMatchObject({
      revision: 1,
    });
    expect(
      (await on(ownerToken, 'POST', `/requirements/${key}/revisions/1/accept`, {})).status,
    ).toBe(200);

    const agree = await offer(owner, {
      act: 'requirement.agree',
      key,
      reason: 'Sales confirmed the reminder flow',
    });
    expect(agree.offer).toMatchObject({ revision: 1, reason: 'Sales confirmed the reminder flow' });
    const agreed = await on(ownerToken, 'POST', `/requirements/${key}/agree`, {
      revision: 1,
      reason: 'Sales confirmed the reminder flow',
    });
    expect(agreed.status, JSON.stringify(agreed.body)).toBe(200);
    expect(
      (await offer(owner, { act: 'requirement.agree', key, reason: 'again for the test' })).refused,
    ).toMatch(new RegExp(`^ITEM_ACT_NOT_FROM_STATE: ${key} is agreed`));
  });

  it('offers no sign-off to a member who does not hold it, and says who can', async () => {
    const key = await readyDraft('Discharge notes are readable');
    await on(ownerToken, 'POST', `/requirements/${key}/revisions/1/propose`, {});
    const refused = (await offer(member, { act: 'requirement.accept', key })).refused;
    expect(refused).toMatch(
      /^ITEM_ACT_FORBIDDEN: the person asking does not hold the sign-off .*requirements\.approve.*a project admin can\./,
    );
  });

  it('owes the reason the page asks for, takes none where it asks none, and names a key of the wrong kind', async () => {
    const key = await readyDraft('Opt out reaches the clinic');
    expect((await offer(owner, { act: 'requirement.drop', key })).refused).toMatch(
      /^ITEM_ACT_REASON_REQUIRED: /,
    );
    expect((await offer(owner, { act: 'requirement.propose', key, reason: 'x' })).refused).toMatch(
      /^ITEM_ACT_INVALID: requirement.propose takes no reason/,
    );
    expect(
      (await offer(owner, { act: 'requirement.agree', key: 'FB-1', reason: 'x' })).refused,
    ).toMatch(
      /^ITEM_ACT_INVALID: requirement.agree names a requirement by a requirement key such as REQ-30, not "FB-1"/,
    );
    expect(
      (await offer(owner, { act: 'requirement.defer', key: 'REQ-9999', reason: 'later this year' }))
        .refused,
    ).toMatch(/^ITEM_ACT_UNKNOWN_ITEM: REQ-9999 names no requirement in this project\./);
  });

  it("refuses a reason not in the project's language before any card, naming the field (BC-10)", async () => {
    const key = await readyDraft('Reminders keep their time zone');
    const refused = (
      await offer(owner, {
        act: 'requirement.drop',
        key,
        reason: 'Không cần nữa vì khách hàng đã đổi ý về tính năng này', // i18n-allow: the Vietnamese reason under test
      })
    ).refused;
    expect(refused).toMatch(
      /^ITEM_ACT_NOT_IN_PROJECT_LANGUAGE: reason would be saved on the item, but .* English \(`en`\)/,
    );
    expect(
      (
        await offer(owner, {
          act: 'requirement.drop',
          key,
          reason: 'The customer changed their mind about it',
        })
      ).offer,
    ).toMatchObject({
      act: 'requirement.drop',
    });
  });
});

describe('a feedback triage asked for in chat', () => {
  it('never files an issue: the issue route names the issue that carries it (BC-7)', async () => {
    const fb = await createTestFeedback(projectId, owner, 41);
    expect(
      (await offer(owner, { act: 'feedback.triage', key: fb, route: 'issue' })).refused,
    ).toMatch(
      /^ITEM_ACT_FILES_ISSUE: route issue with no issue would file a new issue, and a chat never files one/,
    );
    expect(
      (await offer(owner, { act: 'feedback.triage', key: fb, route: 'duplicate' })).refused,
    ).toMatch(/^ITEM_ACT_INVALID: route duplicate needs duplicateOf/);
    expect(
      (await offer(owner, { act: 'requirement.drop', key: 'REQ-1', reason: 'x', note: 'y' }))
        .refused,
    ).toMatch(/^ITEM_ACT_INVALID: note belong to feedback.triage only/);
  });

  it('declines with its reason, offered to a triager only, and the press is the triage route', async () => {
    const fb = await createTestFeedback(projectId, owner, 42);
    const note = 'Works as designed: the export needs a filter first';
    const said = await offer(owner, { act: 'feedback.triage', key: fb, route: 'decline', note });
    expect(said.offer).toMatchObject({
      act: 'feedback.triage',
      key: fb,
      from: 'new',
      triage: { route: 'decline', note },
    });
    expect(
      (await offer(member, { act: 'feedback.triage', key: fb, route: 'decline', note })).refused,
    ).toMatch(/^ITEM_ACT_FORBIDDEN: the person asking does not hold feedback\.approve/);
    const pressed = await on(ownerToken, 'POST', `/feedback/${fb}/triage`, said.offer?.triage);
    expect(pressed.status, JSON.stringify(pressed.body)).toBe(200);
    expect(
      (await offer(owner, { act: 'feedback.triage', key: fb, route: 'decline', note })).refused,
    ).toMatch(new RegExp(`^ITEM_ACT_NOT_FROM_STATE: ${fb} is declined`));
  });
});

describe('a design or release act asked for in chat', () => {
  it('names a design or a release the project does not hold', async () => {
    expect((await offer(owner, { act: 'workflow.approve', key: 'no-such-flow' })).refused).toMatch(
      /^ITEM_ACT_UNKNOWN_ITEM: no-such-flow names no workflow in this project\./,
    );
    expect(
      (await offer(owner, { act: 'release.approve', key: '9.9.9', reason: 'ship it' })).refused,
    ).toMatch(/^ITEM_ACT_(UNKNOWN_ITEM|NOT_FROM_STATE): /);
  });
});

describe('the page beside the chat, as a release or an Approvals peek (BC-2)', () => {
  it('loads a release by its version, with its state', async () => {
    await db.execute(sql`
      INSERT INTO pipeline_runs (id, project_id, kind, status, started_at, finished_at, release_version, release_released_at, metadata)
      VALUES (${randomUUID()}, ${projectId}, 'system', 'completed', now(), now(), '0.4.0-dev.7', now(),
              ${JSON.stringify({ source: 'release-batch', issueIds: [] })}::jsonb)
    `);
    const item = await loadPageItem(projectId, owner, { kind: 'release', key: '0.4.0-dev.7' });
    expect(item).toMatchObject({ kind: 'release', key: '0.4.0-dev.7', found: true });
  });

  it("loads the decision the peek has open from the asker's own Needs-you read, and says when it is gone", async () => {
    provideNeedsYouDecisionRead(async (_project, userId) =>
      userId === owner
        ? ([
            {
              id: 'fb-triage:FB-42',
              key: 'FB-42',
              title: 'Export button is grey',
              topic: 'feedback',
              question: 'Triage FB-42?',
              opens: { kind: 'feedback', key: 'FB-42' },
              answers: [{ id: 'decline', label: 'Decline' }],
              recommended: { answerId: 'decline', why: 'works as designed', by: 'assistant' },
            },
          ] as never)
        : [],
    );
    const item = await loadPageItem(projectId, owner, { kind: 'approval', key: 'fb-triage:FB-42' });
    expect(item).toMatchObject({
      kind: 'approval',
      found: true,
      decides: 'FB-42',
      recommended: 'decline',
      title: 'Export button is grey',
    });
    const gone = await loadPageItem(projectId, member, {
      kind: 'approval',
      key: 'fb-triage:FB-42',
    });
    expect(gone).toMatchObject({ found: false });
  });
});

describe("a held write's text against the project's language (BC-10)", () => {
  it('refuses Vietnamese feedback text for an English project, and English for a Vietnamese one', async () => {
    const call = JSON.stringify({ title: 'Nút xuất dữ liệu bị mờ khi chưa chọn bộ lọc nào' }); // i18n-allow: the Vietnamese text under test
    const en = await heldLanguageRefusal(projectId, 'feedback', 'forge', call);
    expect(en?.isError).toBe(true);
    expect(JSON.stringify(en)).toMatch(
      /CHAT_TEXT_NOT_IN_PROJECT_LANGUAGE: title would be saved for this project/,
    );

    const vi = (await createTestProject(owner)).id;
    await seedProjectDocument(vi, owner, { environments: {}, extra: { contentLanguage: 'vi' } });
    expect(await heldLanguageRefusal(vi, 'feedback', 'forge', call)).toBeNull();
    const english = JSON.stringify({
      body: 'The export button stays grey until a filter is chosen',
    });
    expect(JSON.stringify(await heldLanguageRefusal(vi, 'comment', 'forge', english))).toMatch(
      /body would be saved/,
    );
    // the person's own reply preferences are theirs, not the project's
    expect(
      await heldLanguageRefusal(projectId, 'preferences', 'forge_preferences', call),
    ).toBeNull();
  });
});
