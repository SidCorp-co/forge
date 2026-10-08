/**
 * A memory read never tells the person asking anything of a project they may not read (REQ-30
 * BC-10; workflow design chat-turn r2, steps `perms` and `denied`). A memory names its sources in
 * prose, and a key beside a sibling project's slug is read in that sibling (MJ-6). It is read there
 * only for a reader who may read the sibling: through the fence of the credential they came on and
 * with `project.read` there. Otherwise it reads as a key placed in a project the text does not
 * name, the same whether the sibling's row exists, is dropped or is missing.
 *
 * Every door a turn reaches is planted: the Assistant's in-process forge_memory and
 * forge_knowledge, the turn's own token over REST, a token fenced to the home project held by a
 * person who reads both, and a person with no role on the sibling over REST search, entries and
 * the knowledge search over memory. A person who may read the sibling is the control.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { MEMORY_EMBEDDING_DIM } from '../../src/db/schema-types.js';
import { api, patToken, userToken } from '../helpers/api.js';
import {
  addProjectMember,
  createTestIssue,
  createTestProject,
  createTestRequirement,
  createTestUser,
} from '../helpers/factories.js';

type Cite = Record<string, unknown> & { ref: string };
type Hit = { sourceRef: string; cites?: Cite[]; staleRefs?: unknown[] };
type Toolset = import('../../src/assistant/tools/mcp-adapter.js').ChatToolset;

const VEC = `[${Array.from({ length: MEMORY_EMBEDDING_DIM }, () => 0.1).join(',')}]`;
const REF = 'gotcha/payroll';

const ids = { home: '', sibling: '', siblingSlug: '', owner: '', asker: '' };
const tokens = { owner: '', ownerFenced: '', asker: '', ownerTurn: '', askerTurn: '' };
const turns: Record<'owner' | 'asker', Toolset | null> = { owner: null, asker: null };
let resultText: (r: Awaited<ReturnType<Toolset['execute']>>) => string;

/** The sibling's keys as nobody outside it may read them: no project, unchecked, nothing else. */
const UNREAD = ['ISS-1', 'ISS-2', 'ISS-3', 'REQ-1'].map((ref) => ({
  ref,
  kind: ref.startsWith('REQ') ? 'requirement' : 'issue',
  project: null,
  state: 'unchecked',
}));

beforeAll(async () => {
  ids.owner = (await createTestUser({ verified: true })).id;
  const home = await createTestProject(ids.owner);
  const sibling = await createTestProject(ids.owner, { orgId: home.orgId });
  ids.home = home.id;
  ids.sibling = sibling.id;
  ids.siblingSlug = sibling.slug;
  await addProjectMember(ids.home, ids.owner, 'admin');
  await addProjectMember(ids.sibling, ids.owner, 'admin');
  // the person asking is a member of home and holds nothing on the sibling
  ids.asker = (await createTestUser({ verified: true })).id;
  await addProjectMember(ids.home, ids.asker, 'member');

  // the sibling's ISS-1 is dropped, ISS-2 does not exist, ISS-3 and REQ-1 are live
  const at = new Date();
  await createTestIssue(ids.sibling, ids.owner, 1, { status: 'dropped', createdAt: at });
  await createTestIssue(ids.sibling, ids.owner, 3, { status: 'open', createdAt: at });
  await createTestRequirement(ids.sibling, 1, 'Sibling payroll requirement');
  // home holds none of these numbers, so a key wrongly read here would read gone
  const s = sibling.slug;
  await db.execute(sql`
    INSERT INTO memories (project_id, source, source_ref, text_content, metadata, embedding, embedded_at)
    VALUES (${ids.home}, 'note', ${REF},
            ${`Payroll export moved to ${s} ISS-1, then ${s} ISS-2, then ${s} ISS-3; see ${s} REQ-1.`},
            '{}'::jsonb, ${VEC}::vector, now() - interval '2 days')
  `);

  tokens.owner = await userToken(ids.owner);
  tokens.asker = await userToken(ids.asker);
  tokens.ownerFenced = await patToken(ids.owner, [ids.home], 'fenced-home');

  const { CHAT_TURN_MENU, mintTurnCredential } = await import(
    '../../src/credentials/turn-credential.js'
  );
  const { resolveTurnAuthority } = await import('../../src/permissions/index.js');
  const { buildProjectToolset } = await import('../../src/assistant/tools/registry.js');
  const { buildChatToolContext } = await import('../../src/assistant/tools/principal.js');
  const { toolResultText } = await import('../../src/assistant/tools/mcp-adapter.js');
  resultText = toolResultText;
  for (const who of ['owner', 'asker'] as const) {
    const userId = ids[who];
    const resolved = await resolveTurnAuthority({ userId, projectId: ids.home, viaTokenId: null });
    if (!resolved.ok) throw new Error(resolved.refusal.message);
    const credential = await mintTurnCredential({
      authority: resolved.authority,
      menu: CHAT_TURN_MENU,
      ttlMs: 10 * 60_000,
    });
    tokens[`${who}Turn`] = credential.token;
    turns[who] = buildProjectToolset(
      buildChatToolContext({
        credential,
        projectSlug: home.slug,
        turn: { conversationId: randomUUID(), speakerUserId: userId, handleUserId: null },
      }),
    );
  }
});

const ofRef = (hits: Hit[]): Hit => {
  const hit = hits.find((h) => h.sourceRef === REF);
  if (!hit) throw new Error(`no hit for ${REF} in ${JSON.stringify(hits)}`);
  return hit;
};

async function restSearch(token: string): Promise<Hit> {
  const res = await api(token, 'POST', '/api/memory/search', {
    projectId: ids.home,
    query: 'Payroll',
    strategy: 'keyword',
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return ofRef(res.body.hits as Hit[]);
}

async function restEntries(token: string): Promise<Hit> {
  const res = await api(token, 'GET', `/api/memory/entries?projectId=${ids.home}`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return ofRef(res.body.items as Hit[]);
}

async function restKnowledgeSearch(token: string): Promise<Hit> {
  const res = await api(token, 'POST', `/api/projects/${ids.home}/knowledge/search`, {
    query: 'Payroll',
    scope: 'memory',
    strategy: 'keyword',
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return ofRef(res.body.memory as Hit[]);
}

async function turnTool(who: 'owner' | 'asker', name: string, args: object): Promise<Hit> {
  const set = turns[who];
  if (!set) throw new Error(`no turn for ${who}`);
  const out = JSON.parse(resultText(await set.execute(name, JSON.stringify(args))));
  return ofRef((out.hits ?? out.memory) as Hit[]);
}

/** A hit that read nothing of the sibling: each key unchecked with no project, no stale list. */
function readsNothingOfTheSibling(hit: Hit) {
  expect(hit.cites).toEqual(UNREAD);
  expect(hit.staleRefs ?? []).toEqual([]);
  const { text: _text, sourceRef: _ref, ...rest } = hit as Hit & { text?: string };
  // the memory's own words name the slug; nothing the server read of the sibling does
  expect(JSON.stringify(rest)).not.toContain(ids.siblingSlug);
}

describe('a person who may read the sibling reads its keys there (the control)', () => {
  it('reads the dropped, missing and live keys against the sibling, over search and entries', async () => {
    for (const hit of [await restSearch(tokens.owner), await restEntries(tokens.owner)]) {
      expect(hit.cites).toEqual([
        { ref: 'ISS-1', kind: 'issue', project: ids.siblingSlug, state: 'gone', why: 'dropped' },
        { ref: 'ISS-2', kind: 'issue', project: ids.siblingSlug, state: 'gone', why: 'missing' },
        {
          ref: 'ISS-3',
          kind: 'issue',
          project: ids.siblingSlug,
          state: 'resolved',
          changedAt: expect.any(String),
        },
        {
          ref: 'REQ-1',
          kind: 'requirement',
          project: ids.siblingSlug,
          state: 'resolved',
          changedAt: expect.any(String),
        },
      ]);
    }
  });
});

describe('a turn reads nothing of a project outside its fence', () => {
  it("the Assistant's forge_memory search, for an asker with no role on the sibling", async () => {
    readsNothingOfTheSibling(
      await turnTool('asker', 'forge_memory', {
        action: 'search',
        query: 'Payroll',
        strategy: 'keyword',
      }),
    );
  });

  it("the Assistant's forge_memory search, for an asker who reads the sibling outside the turn", async () => {
    readsNothingOfTheSibling(
      await turnTool('owner', 'forge_memory', {
        action: 'search',
        query: 'Payroll',
        strategy: 'keyword',
      }),
    );
  });

  it("the Assistant's forge_knowledge search over memory", async () => {
    for (const who of ['asker', 'owner'] as const) {
      readsNothingOfTheSibling(
        await turnTool(who, 'forge_knowledge', {
          action: 'search',
          query: 'Payroll',
          scope: 'memory',
          strategy: 'keyword',
        }),
      );
    }
  });

  it("the turn's own token over REST, as its forge CLI sends it", async () => {
    for (const token of [tokens.askerTurn, tokens.ownerTurn]) {
      readsNothingOfTheSibling(await restSearch(token));
      readsNothingOfTheSibling(await restEntries(token));
    }
  });
});

describe('REST reads nothing of a project the reader may not read', () => {
  it('a token fenced to home, held by a person who reads both projects', async () => {
    readsNothingOfTheSibling(await restSearch(tokens.ownerFenced));
    readsNothingOfTheSibling(await restEntries(tokens.ownerFenced));
    readsNothingOfTheSibling(await restKnowledgeSearch(tokens.ownerFenced));
  });

  it('a person with no role on the sibling, on a session', async () => {
    readsNothingOfTheSibling(await restSearch(tokens.asker));
    readsNothingOfTheSibling(await restEntries(tokens.asker));
    readsNothingOfTheSibling(await restKnowledgeSearch(tokens.asker));
  });

  it('a dropped, a missing and a live row read alike: nothing tells them apart', async () => {
    const hit = await restSearch(tokens.asker);
    const shapes = (hit.cites ?? []).map(({ ref: _ref, kind: _kind, ...rest }) => rest);
    expect(new Set(shapes.map((s) => JSON.stringify(s)))).toEqual(
      new Set([JSON.stringify({ project: null, state: 'unchecked' })]),
    );
  });
});
