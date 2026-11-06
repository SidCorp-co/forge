// @direct-test-of packages/core/src/assistant/tools/item-act-set.ts
// @direct-test-of packages/core/src/assistant/tools/item-act-plans.ts
// @direct-test-of packages/core/src/assistant/tools/item-act-doors.ts
// @direct-test-of packages/core/src/assistant/tools/item-act-state.ts
// @direct-test-of packages/core/src/assistant/tools/decide-tool.ts
// @direct-test-of packages/core/src/release-batch/cut-as.ts
/**
 * REQ-69 BC-3, BC-4, BC-5, BC-10 (ISS-692): the chat makes the Product acts a person takes on a
 * requirement, a feedback item, a workflow design and a release, on their word, through each act's
 * own core door, as them. Each message goes through the real send route, the real window routing and
 * the real assistant turn; only the model is scripted. The first turn puts the acts to the person as
 * a set, saying what each records where; the person's next message agrees it, and the turn makes it,
 * reading each item back. A door that refuses is named with its own code and the next step, and text
 * the act would save in another language than the project's is caught before any set is kept.
 */

import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { api } from '../helpers/api.js';
import { createTestFeedback, createTestRequirement, rows } from '../helpers/factories.js';
import { F4, landedIssue, seedLandedWorld, world } from '../helpers/landed-world.js';
import { resetScript, type ScriptStep, script } from '../helpers/scripted-chat.js';

vi.mock('../../src/integrations/llm/chat.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/integrations/llm/chat.js')>()),
  chatModelName: () => 'scripted',
  openChat: (await import('../helpers/scripted-chat.js')).scriptedOpenChat,
}));

vi.mock('../../src/release-batch/ancestry-source.js', async (importOriginal) => {
  const { reader } = await import('../helpers/landed-history.js');
  return {
    ...(await importOriginal<typeof import('../../src/release-batch/ancestry-source.js')>()),
    ancestrySourceFor: async () => ({ kind: 'box', why: 'the planted box', reader }),
  };
});

const { claimDueWindows, claimOf } = await import('../../src/conversations/index.js');
const { routeWebWindow } = await import('../../src/assistant/conversation-send.js');

type Doc = Record<string, unknown>;
interface Room {
  id: string;
  externalId: string;
}

let room: Room;
let version = '';
/** The room's mode is written by its first message and never sent again. */
let spoken = false;

/** Route whatever window the room still owes, as the next send or the recovery drain would. */
async function routeOwed(): Promise<void> {
  for (;;) {
    const [window] = await claimDueWindows({
      adapter: 'web',
      claimant: 'item-acts-probe',
      limit: 1,
      venuePrefixes: [room.externalId],
      settleMs: 0,
    });
    if (!window) return;
    const claim = claimOf(window);
    if (claim) await routeWebWindow(window, claim);
  }
}

/** The person says `content`; the model answers with `steps`; the tool results it was handed, in order. */
async function turn(content: string, steps: ScriptStep[]): Promise<string[]> {
  resetScript();
  script.steps = steps;
  const sent = await api(world.token, 'POST', `/api/conversations/${room.id}/messages`, {
    content,
    ...(spoken ? {} : { mode: 'assistant' }),
  });
  spoken = true;
  expect(sent.status, JSON.stringify(sent.body)).toBe(201);
  await routeOwed();
  const last = script.sent.at(-1) ?? [];
  return last
    .filter((m) => m.role === 'tool')
    .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)));
}

/** The newest set the room put to the person. */
async function newestSet(): Promise<{ id: string; items: Doc[] } | null> {
  const [row] = await rows<{ id: string; items: Doc[] }>(sql`
    SELECT id, items FROM chat_decision_sets WHERE conversation_id = ${room.id}
    ORDER BY created_at DESC LIMIT 1`);
  return row ?? null;
}

const statusOf = async (table: 'requirements' | 'feedback', seqCol: string, seq: number) =>
  (
    await rows<{ status: string }>(
      sql`SELECT status FROM ${sql.raw(table)} WHERE project_id = ${world.projectId} AND ${sql.raw(seqCol)} = ${seq}`,
    )
  )[0]?.status;

const designStatus = async (flow: string) =>
  (
    await rows<{ design_status: string | null }>(
      sql`SELECT design_status FROM project_workflows WHERE project_id = ${world.projectId} AND flow = ${flow}`,
    )
  )[0]?.design_status;

beforeAll(async () => {
  await seedLandedWorld({ verdictsRequired: false });
  await landedIssue(5, F4);
  await createTestRequirement(world.projectId, 801, 'Export reports to CSV');
  await createTestRequirement(world.projectId, 802, 'Import reports from CSV');
  await createTestFeedback(world.projectId, world.ownerId, 801);
  const document = JSON.parse(
    readFileSync(
      new URL('../fixtures/workflows/post-discharge.design.json', import.meta.url),
      'utf8',
    ),
  );
  const drawn = await api(world.token, 'POST', `/api/projects/${world.projectId}/workflows`, {
    baseRevision: null,
    document: { ...document, project: world.projectId, flow: 'chat-acts' },
  });
  expect(drawn.status, JSON.stringify(drawn.body)).toBe(201);
  const listed = await api(world.token, 'GET', `/api/projects/${world.projectId}/releases`);
  expect(listed.status, JSON.stringify(listed.body)).toBe(200);
  version =
    (listed.body.releases as Array<{ version: string; state: string }>).find(
      (r) => r.state === 'draft',
    )?.version ?? '';
  expect(version, JSON.stringify(listed.body)).not.toBe('');
  const opened = await api(world.token, 'POST', '/api/conversations', {
    projectId: world.projectId,
    title: 'item acts',
    people: [],
  });
  expect(opened.status, JSON.stringify(opened.body)).toBe(201);
  room = opened.body as unknown as Room;
}, 120_000);

describe("the chat makes a person's Product acts on their word, one per item kind (REQ-69 BC-3, BC-4, BC-5)", () => {
  it('puts the acts to the person saying what each records where, then makes them through each door and reads every item back', async () => {
    const acts = [
      { act: 'requirement.defer', key: 'REQ-801', reason: 'It waits for the reporting rework' },
      {
        act: 'feedback.triage',
        key: 'FB-801',
        triage: { route: 'decline', note: 'The board already shows this on its filters' },
      },
      { act: 'workflow.propose', key: 'chat-acts' },
      { act: 'release.approve', key: version, reason: 'Release notes read' },
    ];
    const [put] = await turn('Defer REQ-801, decline FB-801, propose chat-acts and approve it', [
      { tool: { name: 'put_decision_set', args: { acts } } },
      { text: 'Here is what I will do once you agree.' },
    ]);
    const offered = JSON.parse(put ?? '{}') as { set?: string; items?: Doc[] };
    expect(offered.set, put).toBeTruthy();
    expect(offered.items?.map((i) => i.key)).toEqual(['REQ-801', 'FB-801', 'chat-acts', version]);
    // BC-4: before the write, what each act records and where
    for (const item of offered.items ?? []) expect(String(item.said)).toMatch(/^Making it /);
    // nothing moved on the put
    expect(await statusOf('requirements', 'req_seq', 801)).toBe('draft');
    expect(await statusOf('feedback', 'fb_seq', 801)).toBe('new');
    expect(await designStatus('chat-acts')).toBe('draft');

    const [made] = await turn('Yes, do it', [
      { tool: { name: 'act_on_decisions', args: { word: 'do it', set: offered.set } } },
      { text: 'Done.' },
    ]);
    const results = (JSON.parse(made ?? '{}') as { results?: Doc[] }).results ?? [];
    expect(
      results.map((r) => [r.outcome, (r.state as Doc | null)?.key]),
      made,
    ).toEqual([
      ['done', 'REQ-801'],
      ['done', 'FB-801'],
      ['done', 'chat-acts'],
      ['done', version],
    ]);
    expect(await statusOf('requirements', 'req_seq', 801)).toBe('deferred');
    expect(await statusOf('feedback', 'fb_seq', 801)).toBe('declined');
    expect(await designStatus('chat-acts')).toBe('proposed');
    const [approval] = await rows<{ decision: string; decided_by_user: string }>(sql`
      SELECT decision, decided_by_user FROM release_draft_approvals WHERE project_id = ${world.projectId}`);
    expect(approval).toMatchObject({ decision: 'approved', decided_by_user: world.ownerId });
    // BC-5: each item read back as it now stands, the requirement with who moved it
    const req = results[0]?.state as Doc;
    expect(req.status).toBe('deferred');
    expect(req.movedBy).toBeTruthy();
  });

  it("names a door's refusal by its own code with the next step, and keeps it as a refused act", async () => {
    const [put] = await turn('Bring REQ-801 back', [
      {
        tool: {
          name: 'put_decision_set',
          args: {
            acts: [
              { act: 'requirement.undefer', key: 'REQ-801', reason: 'The rework landed early' },
            ],
          },
        },
      },
      { text: 'Agree?' },
    ]);
    const set = (JSON.parse(put ?? '{}') as { set?: string }).set;
    expect(set, put).toBeTruthy();
    // someone else brings it back on its page before the person's word
    const undone = await api(
      world.token,
      'POST',
      `/api/projects/${world.projectId}/requirements/REQ-801/undefer`,
      { reason: 'Brought back on its page' },
    );
    expect(undone.status, JSON.stringify(undone.body)).toBe(200);
    const [made] = await turn('ok go ahead', [
      { tool: { name: 'act_on_decisions', args: { word: 'go ahead', set } } },
      { text: 'It did not go through.' },
    ]);
    const [r] = (JSON.parse(made ?? '{}') as { results?: Doc[] }).results ?? [];
    expect(r?.outcome, made).toBe('refused');
    expect(String(r?.detail)).toMatch(
      /^Undefer on REQ-801 was refused by its own door: [A-Z][A-Z0-9_]+: /,
    );
    expect(String(r?.next)).toMatch(/^Open REQ-801, fix what the refusal names/);
    expect((r?.state as Doc).status).toBe('draft');
    const kept = await rows<{ item_key: string; via: string; code: string }>(sql`
      SELECT item_key, via, code FROM chat_decision_failures WHERE conversation_id = ${room.id}`);
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({ item_key: 'REQ-801', via: 'chat' });
    expect(kept[0]?.code).toMatch(/^[A-Z][A-Z0-9_]+$/);
  });

  it('refuses an act the person may not take before any set is kept, naming why', async () => {
    const before = (await newestSet())?.id;
    const [put] = await turn('Accept the proposed revision of REQ-802', [
      {
        tool: {
          name: 'put_decision_set',
          args: {
            acts: [{ act: 'requirement.accept', key: 'REQ-802', reason: 'Read it through' }],
          },
        },
      },
      { text: 'It cannot be.' },
    ]);
    expect(put).toMatch(/CHAT_DECISION_SET_REFUSED: ITEM_ACT_NOT_FROM_STATE: requirement.accept/);
    expect((await newestSet())?.id).toBe(before);
  });
});

describe("text an act saves is held to the project's language (REQ-69 BC-10)", () => {
  it('catches a reason written in another language, keeps no set and moves nothing', async () => {
    const before = (await newestSet())?.id;
    const [put] = await turn('Bỏ REQ-802 đi', [
      {
        tool: {
          name: 'put_decision_set',
          args: {
            acts: [
              {
                act: 'requirement.drop',
                key: 'REQ-802',
                reason: 'Không cần nữa vì đã có tính năng khác thay thế', // i18n-allow: the wrong-language text under test
              },
            ],
          },
        },
      },
      { text: 'Rewriting it.' },
    ]);
    expect(put).toMatch(
      /ITEM_ACT_NOT_IN_PROJECT_LANGUAGE: requirement.drop on REQ-802: reason would be saved for this project/,
    );
    expect((await newestSet())?.id).toBe(before);
    expect(await statusOf('requirements', 'req_seq', 802)).toBe('draft');
  });
});
