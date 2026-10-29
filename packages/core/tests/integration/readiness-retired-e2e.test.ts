/**
 * ISS-641 (REQ-34 BC-3; design requirement-to-delivery r19, step `ready`): the ready checklist
 * replaces the readiness suggestion and its gate. Read at dev e4ae5822a, the retired path was still
 * live beside the checklist: a readiness suggestion could be proposed on REST, through the MCP
 * `suggestion_create` door and by the BA's `ba_suggest`, its accept was written, and the requirement
 * read served the newest accepted one as `readiness`. Each door now refuses the kind by name, and
 * nothing reads an accepted one as a requirement's readiness.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, type Body, patToken } from '../helpers/api.js';
import { closeWorld, startQueue, testEnv } from '../helpers/ecosystem-world.js';
import { addProjectMember, createTestProject, createTestUser } from '../helpers/factories.js';

type Toolset = import('../../src/assistant/tools/mcp-adapter.js').ChatToolset;

let projectId = '';
let token = '';
let turn: (requirementKey: string) => Promise<Toolset>;
let plantAccepted: (requirementKey: string) => Promise<string>;

const at = (path: string) => `/api/projects/${projectId}${path}`;
const READINESS = { checks: [{ check: 'has a scope', passed: true }] };
const refusalsOf = (b: Body) =>
  (((b.error as Body | undefined)?.refusals ?? []) as Body[]).map((r) => ({
    code: r.code,
    path: r.path,
    detail: String(r.detail),
  }));

async function agreedRequirement(title: string): Promise<string> {
  const made = await api(token, 'POST', at('/requirements'), {
    title,
    reason: 'the rule it states',
    criteria: [{ body: 'A saved board shows every card it had.' }],
  });
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  const key = made.body.key as string;
  for (const [step, body] of [
    ['propose', {}],
    ['accept', { reason: 'agreed' }],
  ] as const) {
    const r = await api(token, 'POST', at(`/requirements/${key}/revisions/1/${step}`), body);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  }
  return key;
}

async function readinessRowsOn(key: string): Promise<Body[]> {
  const r = await api(token, 'GET', at(`/suggestions?requirement=${key}`));
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return ((r.body.suggestions ?? []) as Body[]).filter((s) => s.kind === 'readiness');
}

function expectRetired(refusals: { code: unknown; path: unknown; detail: string }[]) {
  const retired = refusals.find((r) => r.code === 'SUGGESTION_KIND_RETIRED');
  expect(retired, JSON.stringify(refusals)).toBeDefined();
  expect(retired?.path).toBe('/kind');
  expect(retired?.detail).toContain('ready checklist');
}

beforeAll(async () => {
  testEnv();
  await startQueue();
  const { CHAT_TURN_MENU, mintTurnCredential } = await import(
    '../../src/credentials/turn-credential.js'
  );
  const { resolveTurnAuthority } = await import('../../src/permissions/index.js');
  const { buildChatToolContext } = await import('../../src/assistant/tools/principal.js');
  const { buildBaToolset } = await import('../../src/assistant/tools/ba-tools.js');
  const { rowIn } = await import('../../src/requirements/index.js');
  const { db } = await import('../../src/db/client.js');
  const { sql } = await import('drizzle-orm');
  const owner = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(owner)).id;
  await addProjectMember(projectId, owner, 'owner');
  token = await patToken(owner, [projectId], 'readiness-retired');
  const resolved = await resolveTurnAuthority({ userId: owner, projectId, viaTokenId: null });
  if (!resolved.ok) throw new Error(resolved.refusal.message);
  const credential = await mintTurnCredential({
    authority: resolved.authority,
    menu: CHAT_TURN_MENU,
    ttlMs: 600_000,
  });
  turn = async (key) =>
    buildBaToolset(
      buildChatToolContext({
        credential,
        projectSlug: 'readiness-retired',
        turn: { conversationId: randomUUID(), speakerUserId: owner, handleUserId: null },
      }),
      { projectId, requirementId: (await rowIn(db, projectId, key)).id },
    );
  // a row accepted before the retirement, as the history holds it: no door writes one any more
  plantAccepted = async (key) => {
    const requirementId = (await rowIn(db, projectId, key)).id;
    const id = randomUUID();
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('forge.kernel_txn', txid_current()::text, true)`);
      await tx.execute(sql`
        INSERT INTO suggestions (id, project_id, kind, requirement_id, base_revision, payload, fingerprint, status, producer_kind, decided_by, decided_at)
        VALUES (${id}, ${projectId}, 'readiness', ${requirementId}, 1, ${JSON.stringify(READINESS)}::jsonb, ${id.slice(0, 32)}, 'accepted', 'ba_assistant', ${owner}, now())
      `);
    });
    return id;
  };
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

describe('a readiness suggestion is refused by name at every door', () => {
  it('REST: POST …/suggestions with kind readiness is SUGGESTION_KIND_RETIRED at /kind, and writes nothing', async () => {
    const key = await agreedRequirement('Boards keep their cards (REST)');
    const r = await api(token, 'POST', at('/suggestions'), {
      kind: 'readiness',
      requirement: key,
      baseRevision: 1,
      payload: READINESS,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(422);
    expectRetired(refusalsOf(r.body));
    expect(await readinessRowsOn(key)).toEqual([]);
  });

  it('MCP: forge_design suggestion_create with kind readiness is refused by the same name', async () => {
    const key = await agreedRequirement('Boards keep their cards (MCP)');
    const res = await api(
      token,
      'POST',
      '/mcp',
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'forge_design',
          arguments: {
            action: 'suggestion_create',
            projectId,
            body: { kind: 'readiness', requirement: key, baseRevision: 1, payload: READINESS },
          },
        },
      },
      { accept: 'application/json, text/event-stream' },
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const result = res.body.result as { content: { text: string }[]; isError?: boolean };
    expect(result.isError).toBe(true);
    const text = result.content[0]?.text ?? '';
    expect(text).toContain('SUGGESTION_KIND_RETIRED');
    expect(text).toContain('ready checklist');
    expect(await readinessRowsOn(key)).toEqual([]);
  });

  it('BA: ba_suggest offers no readiness kind, and a call naming it is refused by name', async () => {
    const key = await agreedRequirement('Boards keep their cards (BA)');
    const tools = await turn(key);
    const shown = tools.tools.find((t) => t.function.name === 'ba_suggest')?.function;
    expect(JSON.stringify(shown?.parameters)).not.toContain('"readiness"');
    expect(shown?.description).not.toContain('readiness');
    await tools.execute('ba_read_requirement', '{}');
    const r = await tools.execute(
      'ba_suggest',
      JSON.stringify({ kind: 'readiness', payload: READINESS }),
    );
    expect(r.isError).toBe(true);
    const text = r.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
    expect(text).toContain('SUGGESTION_KIND_RETIRED');
    expect(await readinessRowsOn(key)).toEqual([]);
  });
});

describe('nothing reads an accepted readiness suggestion as a requirement’s readiness', () => {
  it('the requirement detail answers no readiness field, an accepted readiness row standing', async () => {
    const key = await agreedRequirement('Boards keep their cards (read)');
    const id = await plantAccepted(key);
    expect((await readinessRowsOn(key)).map((s) => s.id)).toEqual([id]);
    const r = await api(token, 'GET', at(`/requirements/${key}`));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(Object.keys(r.body)).not.toContain('readiness');
    // the history keeps it as the past event it is; nothing else in the read names it
    const { history, ...rest } = r.body;
    expect(JSON.stringify(rest)).not.toContain(id);
    expect(JSON.stringify(history)).toContain(id);
  });
});

describe('the suggestions guide', () => {
  it('lists no readiness kind', async () => {
    const r = await api(token, 'GET', '/api/guides/suggestions.md');
    expect(r.status).toBe(200);
    const text = String(r.body.text);
    expect(text).toContain('### The kinds, and what each targets');
    expect(text).not.toContain('readiness');
  });
});
