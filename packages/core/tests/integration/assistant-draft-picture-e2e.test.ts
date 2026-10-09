/**
 * REQ-35 BC-10, BC-11, BC-12 (ISS-464), built to Requirement lifecycle r14 (`revision.written`,
 * `picture.drawn or replaced`): the assistant draws a requirement's picture as part of its draft.
 * Before ISS-464 no draft carried a picture: the Assistant's draft tool took a kind and nothing to
 * draw, the BA's suggestions neither, and the picture route is refused from chat, so an assistant's
 * requirement showed no picture until a person drew one. Here the real routes, the real Assistant
 * toolset behind the agreement gate, the BA door and the database answer: the draft names its kind
 * and carries its picture, the press writes both at once with the text alternative written from the
 * content, a holder of project.write replaces it in place, and a draft that would show none is
 * refused before any card or suggestion is offered. A person's own draft still needs none (BC-14).
 */

import { randomUUID } from 'node:crypto';
import { type DraftPicture, describePicture } from '@forge/contracts/requirement-pictures';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AgreementWorld } from '../helpers/chat-agreement-world.js';
import { openAgreementWorld } from '../helpers/chat-agreement-world.js';
import { closeWorld, type Doc, ok, type Reply } from '../helpers/ecosystem-world.js';
import { addProjectMember, createTestIssue, createTestUser, rows } from '../helpers/factories.js';
import { DRAWN, TABLE } from '../helpers/requirement-picture-world.js';

type Toolset = import('../../src/assistant/tools/mcp-adapter.js').ChatToolset;

let w: AgreementWorld;
let ba: (key: string) => Promise<Toolset>;
const at = (path: string) => `/api/projects/${w.projectId}${path}`;
const as = (who: string, method: string, path: string, body?: unknown) =>
  w.say(who as 'owner', method, at(path), body);
const text = (r: { content: { type: string; text?: string }[] }) =>
  r.content.map((b) => b.text ?? '').join('\n');
const heldId = (said: string) => /proposal ([0-9a-f-]{36})/.exec(said)?.[1] ?? '';
const press = (id: string) =>
  w.say('owner', 'POST', `/api/conversations/${w.roomId}/proposals/${id}/agree`, {});
const refusals = (r: Reply) =>
  ((r.json?.error?.refusals ?? []) as Doc[]).map((x) => `${x.code} ${x.path}`);
const count = async (table: 'requirements' | 'chat_proposals' | 'suggestions') =>
  Number(
    (
      await rows<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM ${sql.raw(table)} WHERE project_id = ${w.projectId}`,
      )
    )[0]?.n,
  );
const read = async (key: string) => ok(await as('owner', 'GET', `/requirements/${key}`));
const revisionOf = async (key: string, n: number) =>
  ((await read(key)).revisions as Doc[]).find((r) => r.revision === n) as Doc;
const historyOf = async (key: string) =>
  ((await read(key)).history as Doc[]).map((e) => `${e.kind}: ${e.text}`);
/** The requirement the press recorded, as the proposal names it. */
const recorded = (r: Reply) => /^(REQ-\d+)/.exec(String(r.json?.proposal?.record?.ref))?.[1] ?? '';

const draft = (title: string, extra: Doc = {}) => ({
  title,
  reason: 'Buyers ask for refunds by email today.',
  criteria: [{ body: 'A buyer asks for a refund from the order page.' }],
  ...extra,
});

/** Agree r1 so a revision can open on it, as a person does on the page. */
async function agreeR1(key: string) {
  ok(await as('owner', 'POST', `/requirements/${key}/revisions/1/propose`, {}));
  ok(await as('owner', 'POST', `/requirements/${key}/revisions/1/accept`, { reason: 'agreed' }));
}

beforeAll(async () => {
  w = await openAgreementWorld('Draft a requirement for refunds, please.');
  const { signUserToken } = await import('../../src/credentials/jwt.js');
  const viewer = (await createTestUser({ verified: true })).id;
  await addProjectMember(w.projectId, viewer, 'viewer');
  w.tokens.viewer = await signUserToken(viewer);
  const { CHAT_TURN_MENU, mintTurnCredential } = await import(
    '../../src/credentials/turn-credential.js'
  );
  const { resolveTurnAuthority } = await import('../../src/permissions/index.js');
  const { buildChatToolContext } = await import('../../src/assistant/tools/principal.js');
  const { buildBaToolset } = await import('../../src/assistant/tools/ba-tools.js');
  const { rowIn } = await import('../../src/requirements/index.js');
  const { db } = await import('../../src/db/client.js');
  const resolved = await resolveTurnAuthority({
    userId: w.owner,
    projectId: w.projectId,
    viaTokenId: null,
  });
  if (!resolved.ok) throw new Error(resolved.refusal.message);
  const credential = await mintTurnCredential({
    authority: resolved.authority,
    menu: CHAT_TURN_MENU,
    ttlMs: 600_000,
  });
  ba = async (key) =>
    buildBaToolset(
      buildChatToolContext({
        credential,
        projectSlug: w.projectSlug,
        turn: { conversationId: randomUUID(), speakerUserId: w.owner, handleUserId: null },
      }),
      { projectId: w.projectId, requirementId: (await rowIn(db, w.projectId, key)).id },
    );
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

describe("the Assistant's draft carries its picture, shown the moment it is recorded", () => {
  let key = '';
  const flowAlt = describePicture(DRAWN.process as DraftPicture);

  it('refuses a draft that draws no picture before any card is offered (criterion 4)', async () => {
    const [requirements, cards] = [await count('requirements'), await count('chat_proposals')];
    const r = await w
      .gate()
      .tools.execute('forge_requirement_draft', JSON.stringify(draft('No picture')));
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('REQUIREMENT_PICTURE_NOT_DRAWN');
    expect([await count('requirements'), await count('chat_proposals')]).toEqual([
      requirements,
      cards,
    ]);
  });

  it('refuses a picture of another kind than the one it names (criterion 6, BC-2)', async () => {
    const r = await w
      .gate()
      .tools.execute(
        'forge_requirement_draft',
        JSON.stringify(draft('A rule drawn as a flow', { kind: 'rule', picture: DRAWN.process })),
      );
    expect(text(r)).toContain('REQUIREMENT_PICTURE_KIND_MISMATCH');
    expect(text(r)).toContain('/picture/kind');
  });

  it('holds a drawn draft on a card that shows its picture as a rough sketch (criteria 2, 7)', async () => {
    const r = await w
      .gate()
      .tools.execute(
        'forge_requirement_draft',
        JSON.stringify(
          draft('Refunds within 14 days', { kind: 'process', picture: DRAWN.process }),
        ),
      );
    const id = heldId(text(r));
    expect(id).not.toBe('');
    const cards = (await w.say('owner', 'GET', `/api/conversations/${w.roomId}/proposals`)).json
      .proposals as Doc[];
    expect(cards.find((p) => p.id === id)?.summary.lines).toContain(
      `Picture, a rough sketch (a flow): ${flowAlt}`,
    );

    const written = await press(id);
    expect(written.status, JSON.stringify(written.json)).toBe(200);
    expect(written.json.proposal).toMatchObject({ status: 'recorded' });
    key = recorded(written);
    expect(key).toMatch(/^REQ-\d+$/);
  });

  it('shows the picture on the first read, of its kind, with no accept (criterion 1, BC-10)', async () => {
    const r1 = await revisionOf(key, 1);
    expect(r1).toMatchObject({ state: 'draft', kind: 'process' });
    expect(r1.picture).toMatchObject({
      kind: 'flow',
      content: DRAWN.process.content,
      roughSketch: true,
      drawnFor: 1,
      writtenBy: w.owner,
    });
  });

  it('writes its text alternative from its content, never empty (criterion 3, BC-12)', async () => {
    const { picture } = await revisionOf(key, 1);
    expect(picture.alt).toBe(flowAlt);
    expect(picture.alt).toBe('A flow of 2 steps: Cart to Pay.');
  });

  it('is labelled a rough sketch where its history tells it (criterion 2, BC-11)', async () => {
    expect(await historyOf(key)).toContain(
      `Picture: Drew the picture of r1, a rough sketch: ${flowAlt}`,
    );
  });

  it('a member who can edit replaces it in place; both stay in the history (criteria 1, 9)', async () => {
    const replaced = ok(
      await as('member', 'PUT', `/requirements/${key}/revisions/1/picture`, {
        ...DRAWN.process,
        alt: 'The cart leads to payment, redrawn.',
      }),
    );
    expect(replaced.key).toBe(key);
    expect((await revisionOf(key, 1)).picture).toMatchObject({
      writtenBy: expect.not.stringMatching(w.owner),
      alt: 'The cart leads to payment, redrawn.',
    });
    expect(await historyOf(key)).toContain(
      'Picture: Replaced the picture of r1, a rough sketch: The cart leads to payment, redrawn.',
    );
  });

  it('a viewer, who cannot edit, is refused and the picture stays (criterion 1)', async () => {
    const r = await as('viewer', 'PUT', `/requirements/${key}/revisions/1/picture`, {
      ...DRAWN.process,
      alt: 'A viewer redraws it.',
    });
    expect(r.status, JSON.stringify(r.json)).toBe(403);
    expect(JSON.stringify(r.json)).toContain('PERMISSION_FORBIDDEN');
    expect((await revisionOf(key, 1)).picture.alt).toBe('The cart leads to payment, redrawn.');
  });
});

describe("the Assistant's revision shows a picture with no second act (criterion 5)", () => {
  let key = '';
  beforeAll(async () => {
    const held = await w
      .gate()
      .tools.execute(
        'forge_requirement_draft',
        JSON.stringify(draft('Refunds are counted', { kind: 'process', picture: DRAWN.process })),
      );
    key = recorded(await press(heldId(text(held))));
    await agreeR1(key);
  });
  const revise = (extra: Doc) =>
    w.gate().tools.execute(
      'forge_requirement_revise',
      JSON.stringify({
        requirement: key,
        baseRevision: 1,
        reason: 'Refunds are counted per week.',
        criteria: [{ code: 'BC-1', body: 'A buyer asks for a refund from the order page.' }],
        ...extra,
      }),
    );

  it('refuses a revision whose kind changes and draws nothing: it would show none', async () => {
    const r = await revise({ kind: 'rule' });
    expect(text(r)).toContain('REQUIREMENT_PICTURE_NOT_DRAWN');
    expect(text(r)).toContain('draws an example table');
  });

  it("carries the head's picture where the kind stays", async () => {
    const id = heldId(text(await revise({})));
    expect(id).not.toBe('');
    ok(await press(id));
    const r2 = await revisionOf(key, 2);
    expect(r2.kind).toBe('process');
    expect(r2.picture).toMatchObject({ kind: 'flow', drawnFor: 1 });
  });

  it('draws its own where the kind changes, shown on r2 at once', async () => {
    ok(await as('owner', 'POST', `/requirements/${key}/revisions/2/propose`, {}));
    ok(await as('owner', 'POST', `/requirements/${key}/revisions/2/accept`, { reason: 'agreed' }));
    const id = heldId(
      text(
        await w.gate().tools.execute(
          'forge_requirement_revise',
          JSON.stringify({
            requirement: key,
            baseRevision: 2,
            reason: 'It is a rule with examples.',
            kind: 'rule',
            picture: DRAWN.rule,
            criteria: [{ code: 'BC-1', body: 'A buyer asks for a refund from the order page.' }],
          }),
        ),
      ),
    );
    ok(await press(id));
    const r3 = await revisionOf(key, 3);
    expect(r3).toMatchObject({ kind: 'rule', state: 'draft' });
    expect(r3.picture).toMatchObject({ kind: 'example_table', content: TABLE, drawnFor: 3 });
    expect(r3.picture.alt).toBe(describePicture(DRAWN.rule as DraftPicture));
  });
});

describe("the BA's drafts carry their picture (criteria 4, 5)", () => {
  const wish = (extra: Doc = {}) => ({
    kind: 'revision_diff',
    payload: {
      reason: 'the BA drafted it',
      criteria: [{ code: 'BC-1', body: 'A buyer asks for a refund from the order page.' }],
      ...extra,
    },
  });
  const call = async (tools: Toolset, name: string, args: Doc) => {
    const r = await tools.execute(name, JSON.stringify(args));
    return { isError: r.isError === true, json: JSON.parse(text(r)) as Doc };
  };
  const newRequirement = async (title: string) =>
    ok(await as('owner', 'POST', '/requirements', draft(title)), 201).key as string;

  it('refuses a revision drafted with no picture, before a suggestion is proposed', async () => {
    const key = await newRequirement('Refunds by the BA, undrawn');
    const before = await count('suggestions');
    const r = await call(await ba(key), 'ba_suggest', wish());
    expect(r.isError).toBe(true);
    expect(r.json.error.refusals.map((x: Doc) => `${x.code} ${x.path}`)).toEqual([
      'REQUIREMENT_PICTURE_NOT_DRAWN /payload/picture',
    ]);
    expect(await count('suggestions')).toBe(before);
  });

  it('proposes a drawn revision, and its accept shows the picture on the draft it rewrites', async () => {
    const key = await newRequirement('Refunds by the BA, drawn');
    const r = await call(
      await ba(key),
      'ba_suggest',
      wish({ kind: 'screen', picture: DRAWN.screen }),
    );
    expect(r.isError, JSON.stringify(r.json)).toBe(false);
    ok(
      await as('owner', 'POST', `/suggestions/${r.json.suggestion.id}/accept`, {
        reason: 'the BA drew it',
      }),
    );
    const r1 = await revisionOf(key, 1);
    expect(r1).toMatchObject({ kind: 'screen', state: 'proposed' });
    expect(r1.picture).toMatchObject({
      kind: 'wireframe',
      roughSketch: true,
      alt: 'A wireframe "Checkout": 1 shape.',
    });
  });

  it('refuses a new requirement the BA drafts without a picture', async () => {
    const issue = await createTestIssue(w.projectId, w.owner, 901, {
      status: 'draft',
      createdAt: new Date(),
    });
    const key = await newRequirement('A room for the BA');
    const r = await call(await ba(key), 'ba_suggest', {
      kind: 'requirement_draft',
      issue: issue.key,
      payload: { title: 'Refunds', reason: 'asked', criteria: [{ body: 'A refund is asked.' }] },
    });
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.json)).toContain('REQUIREMENT_PICTURE_NOT_DRAWN');
  });
});

describe("a person's draft needs no picture, and one it carries meets the rules (criteria 6, 8)", () => {
  it('creates a requirement with no picture, which blocks nothing (BC-14)', async () => {
    const made = ok(await as('owner', 'POST', '/requirements', draft('No picture yet')), 201);
    expect(((made.revisions as Doc[])[0] as Doc).picture).toBeNull();
  });

  it('draws the picture a REST draft carries, its alt written from the content', async () => {
    const made = ok(
      await as(
        'owner',
        'POST',
        '/requirements',
        draft('A report', { kind: 'report', picture: DRAWN.report }),
      ),
      201,
    );
    const r1 = (made.revisions as Doc[])[0] as Doc;
    expect(r1.picture).toMatchObject({
      kind: 'chart',
      alt: 'A sample bar chart of Orders by Week, from 2 sample rows.',
    });
  });

  it.each([
    [
      'a picture of another kind',
      { kind: 'rule', picture: DRAWN.process },
      ['REQUIREMENT_PICTURE_KIND_MISMATCH /picture/kind'],
    ],
    [
      'a row with no expected result (BC-4)',
      {
        kind: 'rule',
        picture: { kind: 'example_table', content: { rows: [{ input: '1 item' }] } },
      },
      ['REQUIREMENT_PICTURE_ROW_INCOMPLETE /picture/content/rows/0'],
    ],
    [
      'a blank text alternative (BC-12)',
      { kind: 'process', picture: { ...DRAWN.process, alt: '' } },
      ['REQUIREMENT_PICTURE_ALT_REQUIRED /picture/alt'],
    ],
    [
      'a picture with no kind named',
      { picture: DRAWN.process },
      ['REQUIREMENT_PICTURE_KIND_MISMATCH /kind'],
    ],
  ])('refuses %s by name, writing nothing', async (_what, extra, expected) => {
    const before = await count('requirements');
    const r = await as('owner', 'POST', '/requirements', draft('Refused', extra));
    expect(r.status, JSON.stringify(r.json)).toBe(422);
    expect(refusals(r)).toEqual(expected);
    expect(await count('requirements')).toBe(before);
  });

  it("refuses an Agent session's held draft whose picture does not fit, before a card is offered", async () => {
    const before = await count('chat_proposals');
    const r = await w.say(
      'agent',
      'POST',
      at('/requirements'),
      draft('An Agent draft', { kind: 'rule', picture: DRAWN.process }),
    );
    expect(refusals(r)).toEqual(['REQUIREMENT_PICTURE_KIND_MISMATCH /picture/kind']);
    expect(await count('chat_proposals')).toBe(before);
    const held = await w.say(
      'agent',
      'POST',
      at('/requirements'),
      draft('An Agent draft', { kind: 'rule', picture: DRAWN.rule }),
    );
    expect(held.json?.error?.code ?? held.json?.code).toBe('CHAT_WRITE_AWAITS_AGREEMENT');
  });
});
