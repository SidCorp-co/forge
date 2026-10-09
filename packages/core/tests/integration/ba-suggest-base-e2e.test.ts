/**
 * REQ-30 BC-3: a change wish is recorded as a requirement revision. On forge-dev 0.4.0-dev.193 the
 * BA assistant could not propose any revision on a new requirement: its only revision was a draft
 * (no current one), the model sent `baseRevision: 1` — the revision it had just read — and
 * `ba_suggest` refused SUGGESTION_BASE_STALE ("the target's head is no revision"), twice of three
 * (REQ-31, REQ-36). The model no longer types a base: the tool takes what this turn's
 * ba_read_requirement returned, and a revision_diff may build on the open draft, whose accept
 * rewrites that draft. Its `ba_draw_mockup` queued a requirement mockup for a person to accept;
 * since REQ-35 a requirement's picture is its revision's own, and the door offers that tool no more.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  closeWorld,
  type Doc,
  ok,
  type Reply,
  requester,
  startQueue,
  testEnv,
} from '../helpers/ecosystem-world.js';
import { addProjectMember, createTestProject, createTestUser } from '../helpers/factories.js';
import { DRAWN } from '../helpers/requirement-picture-world.js';

type Toolset = import('../../src/assistant/tools/mcp-adapter.js').ChatToolset;
type Result = import('../../src/lib/tool-result.js').CallToolResult;

let say: (who: 'owner', method: string, path: string, body?: unknown) => Promise<Reply>;
let projectId = '';
let turn: (requirementKey: string) => Promise<Toolset>;
const at = (path: string) => `/api/projects/${projectId}${path}`;
const as = (method: string, path: string, body?: unknown) => say('owner', method, at(path), body);
const body = (r: Result): Doc =>
  JSON.parse(r.content.map((b) => (b.type === 'text' ? b.text : '')).join('')) as Doc;
const call = async (tools: Toolset, name: string, args: Doc) => {
  const r = await tools.execute(name, JSON.stringify(args));
  return { isError: r.isError === true, json: body(r) };
};

const KEPT = { code: 'BC-1', body: 'A lane records its design before coding.' };
const REWORDED = { code: 'BC-2', body: 'A lane runs only the checks its change touches.' };
const ADDED = { body: 'A deploy replays the saved probes.' };
// the BA's drafted revision names its kind and draws its picture (ISS-464, REQ-35 BC-10)
const wish = (criteria: Doc[], extra: Doc = {}): Doc => ({
  kind: 'revision_diff',
  payload: {
    reason: 'the owner asked for the draft to be improved',
    criteria,
    kind: 'process',
    picture: DRAWN.process,
  },
  ...extra,
});

async function newRequirement(title: string): Promise<string> {
  return ok(
    await as('POST', '/requirements', {
      title,
      reason: 'the rule it states',
      criteria: [{ body: KEPT.body }, { body: 'A lane runs its checks.' }],
    }),
    201,
  ).key as string;
}
const read = async (key: string) => ok(await as('GET', `/requirements/${key}`));
const codesOf = (r: Doc | undefined) =>
  ((r?.criteria ?? []) as Doc[]).map((c) => `${c.code} ${c.body}`);

beforeAll(async () => {
  testEnv();
  const { app } = await import('../../src/index.js');
  await startQueue();
  const { signUserToken } = await import('../../src/credentials/jwt.js');
  const { CHAT_TURN_MENU, mintTurnCredential } = await import(
    '../../src/credentials/turn-credential.js'
  );
  const { resolveTurnAuthority } = await import('../../src/permissions/index.js');
  const { buildChatToolContext } = await import('../../src/assistant/tools/principal.js');
  const { buildBaToolset } = await import('../../src/assistant/tools/ba-tools.js');
  const { rowIn } = await import('../../src/requirements/index.js');
  const { db } = await import('../../src/db/client.js');
  const owner = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(owner)).id;
  await addProjectMember(projectId, owner, 'owner');
  say = requester(app, { owner: await signUserToken(owner) });
  const resolved = await resolveTurnAuthority({ userId: owner, projectId, viaTokenId: null });
  if (!resolved.ok) throw new Error(resolved.refusal.message);
  const credential = await mintTurnCredential({
    authority: resolved.authority,
    menu: CHAT_TURN_MENU,
    ttlMs: 600_000,
  });
  // one toolset per turn, as web-turn-inputs builds it for a BA room
  turn = async (key) =>
    buildBaToolset(
      buildChatToolContext({
        credential,
        projectSlug: 'ba-base',
        turn: { conversationId: randomUUID(), speakerUserId: owner, handleUserId: null },
      }),
      { projectId, requirementId: (await rowIn(db, projectId, key)).id },
    );
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

describe('ba_suggest on a requirement whose only revision is a draft', () => {
  it('takes the model’s natural input (base = the revision it read) and records the wish', async () => {
    const key = await newRequirement('Each lane tests only its own scope');
    const tools = await turn(key);
    const seen = await call(tools, 'ba_read_requirement', {});
    expect(seen.json.requirement.currentRevision).toBeNull();
    const made = await call(
      tools,
      'ba_suggest',
      wish([KEPT, REWORDED, ADDED], { baseRevision: 1 }),
    );
    expect(made.isError, JSON.stringify(made.json)).toBe(false);
    expect(made.json.suggestion.status).toBe('proposed');
    const waiting = ok(await as('GET', `/suggestions?requirement=${key}&status=proposed`));
    expect((waiting.suggestions as Doc[]).map((s) => s.baseRevision)).toEqual([1]);

    // its accept rewrites the open draft in place, keeps the codes, gives the new one the next
    ok(
      await as('POST', `/suggestions/${made.json.suggestion.id}/accept`, {
        reason: 'the BA improved it',
      }),
    );
    const after = await read(key);
    expect(after.currentRevision).toBeNull();
    expect(after.latestRevision).toEqual({ revision: 1, state: 'proposed' });
    expect((after.revisions as Doc[]).length).toBe(1);
    expect(codesOf((after.revisions as Doc[])[0])).toEqual([
      `BC-1 ${KEPT.body}`,
      `BC-2 ${REWORDED.body}`,
      `BC-3 ${ADDED.body}`,
    ]);
  });

  it('needs no base at all: an unread turn reads it at creation', async () => {
    const key = await newRequirement('A lane keeps its probes');
    const made = await call(await turn(key), 'ba_suggest', wish([KEPT, ADDED]));
    expect(made.isError, JSON.stringify(made.json)).toBe(false);
    const waiting = ok(await as('GET', `/suggestions?requirement=${key}&status=proposed`));
    expect((waiting.suggestions as Doc[])[0]?.baseRevision).toBe(1);
  });

  it('a model that sends null (REQ-35) is not refused either', async () => {
    const key = await newRequirement('A lane says what it touched');
    const made = await call(await turn(key), 'ba_suggest', wish([KEPT], { baseRevision: null }));
    expect(made.isError, JSON.stringify(made.json)).toBe(false);
  });

  it('still refuses by name a code that is not live on the draft', async () => {
    const key = await newRequirement('A lane names its codes');
    const tools = await turn(key);
    await call(tools, 'ba_read_requirement', {});
    const refused = await call(tools, 'ba_suggest', wish([KEPT, { code: 'BC-9', ...ADDED }]));
    expect(refused.isError).toBe(true);
    expect(refused.json.error.refusals.map((r: Doc) => `${r.code} ${r.path}`)).toEqual([
      'CRITERION_CODE_UNKNOWN /payload/criteria/1/code',
    ]);
  });
});

describe('a person editing their own draft (the same rewrite, kept at draft)', () => {
  it('rewrites the draft in place, keeps its state and its codes', async () => {
    const key = await newRequirement('A lane edits its draft');
    ok(
      await as('PUT', `/requirements/${key}/revisions/1`, {
        reason: 'reworded',
        criteria: [KEPT, REWORDED, ADDED],
      }),
    );
    const after = await read(key);
    expect(after.latestRevision).toEqual({ revision: 1, state: 'draft' });
    expect(codesOf((after.revisions as Doc[])[0])).toEqual([
      `BC-1 ${KEPT.body}`,
      `BC-2 ${REWORDED.body}`,
      `BC-3 ${ADDED.body}`,
    ]);
  });
});

describe('ba_suggest on a requirement with a current revision', () => {
  it('with no open revision: based on the head, its accept writes the next revision', async () => {
    const key = await newRequirement('A lane proves on the running build');
    ok(await as('POST', `/requirements/${key}/revisions/1/propose`, {}));
    ok(await as('POST', `/requirements/${key}/revisions/1/accept`, { reason: 'agreed' }));
    const tools = await turn(key);
    await call(tools, 'ba_read_requirement', {});
    const made = await call(tools, 'ba_suggest', wish([KEPT, REWORDED, ADDED]));
    expect(made.isError, JSON.stringify(made.json)).toBe(false);
    ok(await as('POST', `/suggestions/${made.json.suggestion.id}/accept`, { reason: 'yes' }));
    const after = await read(key);
    expect(after.currentRevision).toBe(1);
    expect(after.latestRevision).toEqual({ revision: 2, state: 'proposed' });
  });

  it('with an open draft r2: based on r2, its accept rewrites r2 rather than refusing', async () => {
    const key = await newRequirement('A lane serialises shared modules');
    ok(await as('POST', `/requirements/${key}/revisions/1/propose`, {}));
    ok(await as('POST', `/requirements/${key}/revisions/1/accept`, { reason: 'agreed' }));
    ok(
      await as('POST', `/requirements/${key}/revisions`, {
        baseRevision: 1,
        reason: 'a person started r2',
        criteria: [KEPT, { code: 'BC-2', body: 'r2 wording' }],
      }),
    );
    const tools = await turn(key);
    await call(tools, 'ba_read_requirement', {});
    const made = await call(tools, 'ba_suggest', wish([KEPT, REWORDED, ADDED]));
    expect(made.isError, JSON.stringify(made.json)).toBe(false);
    ok(await as('POST', `/suggestions/${made.json.suggestion.id}/accept`, { reason: 'yes' }));
    const after = await read(key);
    expect(after.latestRevision).toEqual({ revision: 2, state: 'proposed' });
    expect((after.revisions as Doc[]).length).toBe(2);
    expect(codesOf((after.revisions as Doc[]).find((r) => r.revision === 2))).toEqual([
      `BC-1 ${KEPT.body}`,
      `BC-2 ${REWORDED.body}`,
      `BC-3 ${ADDED.body}`,
    ]);
  });

  it('compare-and-set at accept: a suggestion on the head goes stale once a draft opened', async () => {
    const key = await newRequirement('A lane waits its turn');
    ok(await as('POST', `/requirements/${key}/revisions/1/propose`, {}));
    ok(await as('POST', `/requirements/${key}/revisions/1/accept`, { reason: 'agreed' }));
    const tools = await turn(key);
    await call(tools, 'ba_read_requirement', {});
    const made = await call(tools, 'ba_suggest', wish([KEPT, ADDED]));
    expect(made.isError, JSON.stringify(made.json)).toBe(false);
    ok(
      await as('POST', `/requirements/${key}/revisions`, {
        baseRevision: 1,
        reason: 'a person started r2 meanwhile',
        criteria: [KEPT],
      }),
    );
    const refused = await as('POST', `/suggestions/${made.json.suggestion.id}/accept`, {
      reason: 'yes',
    });
    expect(refused.status).toBe(409);
    expect(refused.json.error.refusals.map((r: Doc) => r.code)).toEqual(['SUGGESTION_BASE_STALE']);
    expect(refused.json.error.refusals[0].detail).toContain('revision 2 is open (draft)');
    const stale = ok(await as('GET', `/suggestions?requirement=${key}&status=stale`));
    expect((stale.suggestions as Doc[]).map((s) => s.id)).toEqual([made.json.suggestion.id]);
  });

  it('the base read this turn is the one recorded, even when the head moved after the read', async () => {
    const key = await newRequirement('A lane reads before it writes');
    const tools = await turn(key);
    await call(tools, 'ba_read_requirement', {}); // reads draft r1, no head
    ok(await as('POST', `/requirements/${key}/revisions/1/propose`, {}));
    ok(await as('POST', `/requirements/${key}/revisions/1/accept`, { reason: 'agreed' }));
    // r1 is now the head and nothing is open: the base the turn read (r1) is still r1
    const made = await call(tools, 'ba_suggest', wish([KEPT, ADDED]));
    expect(made.isError, JSON.stringify(made.json)).toBe(false);
  });
});

describe('the base is what the turn read, never re-read behind its back', () => {
  it('a head that moved after the read refuses the suggestion as stale, naming both', async () => {
    const key = await newRequirement('A lane does not overwrite what it never saw');
    ok(await as('POST', `/requirements/${key}/revisions/1/propose`, {}));
    ok(await as('POST', `/requirements/${key}/revisions/1/accept`, { reason: 'agreed' }));
    const tools = await turn(key);
    await call(tools, 'ba_read_requirement', {}); // head r1, nothing open
    ok(
      await as('POST', `/requirements/${key}/revisions`, {
        baseRevision: 1,
        reason: 'r2 agreed meanwhile',
        criteria: [KEPT, { body: 'a criterion the turn never read' }],
      }),
    );
    ok(await as('POST', `/requirements/${key}/revisions/2/propose`, {}));
    ok(await as('POST', `/requirements/${key}/revisions/2/accept`, { reason: 'agreed' }));
    const refused = await call(tools, 'ba_suggest', wish([KEPT, ADDED]));
    expect(refused.isError).toBe(true);
    expect(refused.json.code).toBe('SUGGESTION_BASE_STALE');
    expect(refused.json.detail).toContain(
      "based on revision 1, but the target's head is revision 2",
    );
  });
});

// REQ-35: a requirement's picture is its revision's own (PUT …/revisions/:n/picture), shown at once
// and pinned by nothing, so the door no longer offers ba_draw_mockup, whose board waited in the
// mockup queue for a person to accept it
describe('the BA door draws no requirement mockup into the accept queue', () => {
  it('offers no ba_draw_mockup', async () => {
    const tools = await turn(await newRequirement('A board nobody queues'));
    expect(tools.tools.map((t) => t.function.name)).not.toContain('ba_draw_mockup');
  });
});
