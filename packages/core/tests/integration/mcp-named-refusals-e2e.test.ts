/**
 * REQ-73 BC-5 (ISS-602 c2): every tool /mcp serves answers an invalid call in Forge's named refusal
 * form — { error: { code, message, refusals: [{ code, path, detail }] } } with the valid shape —
 * whatever part of the tool judged it: its declared input, a per-action `need`, or the resolver of a
 * reference it was handed. Enumerated from the tools the server lists, so a tool added later, or an
 * action added to one, is called here unasked.
 *
 * @direct-test-of packages/core/src/mcp/input-gate.ts
 * @direct-test-of packages/core/src/lib/tool-args.ts
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { mintPat } from '../../src/credentials/pat.js';
import { PAT_GRANT_EPOCH } from '../../src/credentials/pat-permissions.js';
import { api, type Body } from '../helpers/api.js';
import { type World, world } from '../helpers/forecast-world.js';

interface Called {
  isError: boolean;
  text: string;
  body: Body;
}

async function rpc(token: string, method: string, params: Body): Promise<Body> {
  const res = await api(
    token,
    'POST',
    '/mcp',
    { jsonrpc: '2.0', id: 1, method, params },
    { accept: 'application/json, text/event-stream' },
  );
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return (res.body as { result: Body }).result;
}

async function call(token: string, name: string, args: Body): Promise<Called> {
  const result = (await rpc(token, 'tools/call', { name, arguments: args })) as {
    content: { text?: string }[];
    isError?: boolean;
  };
  const text = result.content.map((c) => c.text ?? '').join('\n');
  let body: Body = {};
  try {
    body = JSON.parse(text) as Body;
  } catch {}
  return { isError: result.isError === true, text, body };
}

type Prop = {
  type?: unknown;
  enum?: unknown;
  const?: unknown;
  pattern?: unknown;
  description?: unknown;
};
type Listed = { name: string; inputSchema: { properties?: Record<string, Prop> } };

/** Every action a listed tool takes, as its published input names them. */
function actionsOf(tool: Listed): string[] {
  const action = tool.inputSchema.properties?.action;
  if (Array.isArray(action?.enum)) return action.enum as string[];
  if (typeof action?.const === 'string') return [action.const];
  return [];
}

/**
 * The arguments that name a row: a string the published input gives a pattern, or describes as a
 * key or a uuid. A name looked up as written (a workflow's flow name) is not one: any text is a
 * well-formed name, and one that names nothing is not found rather than malformed.
 */
function referencesOf(tool: Listed): string[] {
  return Object.entries(tool.inputSchema.properties ?? {})
    .filter(
      ([key, p]) =>
        key !== 'projectId' &&
        p.type === 'string' &&
        p.enum === undefined &&
        p.const === undefined &&
        (p.pattern !== undefined || /\b(key|uuid)\b/i.test(String(p.description ?? ''))),
    )
    .map(([key]) => key);
}

/**
 * Why an answer that refuses is not in the named form — a code, a message, every fault at a path,
 * and for a fault in the caller's arguments the shape the tool takes — or null where it is, or
 * where the call was not refused.
 */
function unnamed(c: Called): string | null {
  if (!c.isError) return null;
  const error = c.body.error as
    | { code?: unknown; message?: unknown; refusals?: { path?: unknown; detail?: unknown }[] }
    | undefined;
  if (typeof error?.code !== 'string' || typeof error.message !== 'string') return 'no code';
  const rows = error.refusals ?? [];
  if (rows.length === 0) return 'no refusals';
  if (rows.some((r) => typeof r.path !== 'string' || typeof r.detail !== 'string')) {
    return 'a refusal without path or detail';
  }
  if (error.code === 'BAD_REQUEST') {
    const said = [c.body.detail, ...rows.map((r) => r.detail)].join(' ');
    // a shape is an object of named fields: `{ action: ..., data: ... }`, `{ kind: bug | ..., title }`
    if (!/\{ \w+\??[:,]/.test(said)) return 'no valid shape';
  }
  return null;
}

const shown = (c: Called) => c.text.slice(0, 200);

describe('every /mcp tool names what is wrong with a call it refuses (c2)', () => {
  let w: World;
  let token: string;
  let tools: Listed[];

  beforeAll(async () => {
    w = await world();
    // no project list, so a tool reaching past one project is judged on its arguments, not fenced
    token = (
      await mintPat({
        permissions: ['*'],
        userId: w.userId,
        name: 'iss-602',
        grantEpoch: PAT_GRANT_EPOCH,
      })
    ).plaintext;
    tools = ((await rpc(token, 'tools/list', {})) as { tools: Listed[] }).tools;
  }, 120_000);

  const scoped = (t: Listed, args: Body): Body =>
    t.inputSchema.properties?.projectId ? { projectId: w.projectId, ...args } : args;

  it('finds every tool’s actions and the references it resolves', () => {
    expect(tools.length).toBeGreaterThan(0);
    for (const t of tools) expect(actionsOf(t).length, t.name).toBeGreaterThan(0);
    const refs = tools.flatMap((t) => referencesOf(t).map((f) => `${t.name}.${f}`));
    expect(refs).toEqual(
      expect.arrayContaining([
        'forge_issues.issue',
        'forge_questions.issue',
        'forge_design.mockup',
        'forge_design.requirement',
        'forge_design.feedback',
        'forge_design.issue',
        'forge_requirements.requirement',
        'project_feedback.feedback',
        'project_feedback.requirement',
      ]),
    );
  });

  it('names each field an action needs and was not sent, with the shape', async () => {
    const faults: string[] = [];
    for (const t of tools) {
      for (const action of actionsOf(t)) {
        const c = await call(token, t.name, scoped(t, { action }));
        const fault = unnamed(c);
        if (fault) faults.push(`${t.name} ${action} {}: ${fault}: ${shown(c)}`);
      }
    }
    expect(faults).toEqual([]);
  }, 120_000);

  it('names a reference of the wrong shape, empty, or with trailing text', async () => {
    const faults: string[] = [];
    for (const t of tools) {
      for (const action of actionsOf(t)) {
        for (const field of referencesOf(t)) {
          for (const value of ['ISS602', 'ISS-602x', '#602', '']) {
            const c = await call(token, t.name, scoped(t, { action, [field]: value }));
            const fault = unnamed(c);
            if (fault) {
              faults.push(
                `${t.name} ${action} ${field}=${JSON.stringify(value)}: ${fault}: ${shown(c)}`,
              );
            }
          }
        }
      }
    }
    expect(faults).toEqual([]);
  }, 300_000);

  it('answers a mistyped issue key at /issue with what a key looks like', async () => {
    for (const [name, action] of [
      ['forge_issues', 'get'],
      ['forge_questions', 'list'],
    ] as const) {
      for (const issue of ['ISS602', '#602', 'ISS-602x']) {
        const c = await call(token, name, { action, projectId: w.projectId, issue });
        expect(unnamed(c), `${name} ${action} ${issue}: ${c.text}`).toBeNull();
        expect(c.isError, c.text).toBe(true);
        const error = c.body.error as {
          code: string;
          refusals: { path: string; detail: string }[];
        };
        expect(error.code).toBe('BAD_REQUEST');
        expect(error.refusals[0]?.path).toBe('/issue');
        expect(error.refusals[0]?.detail).toMatch(/ISS-\d+/);
        expect(c.body.detail).toMatch(new RegExp(`^${name} takes \\{ action`));
      }
    }
  });

  it('answers a per-action omission at its field, saying what the field is', async () => {
    const cases = [
      ['forge_requirements', 'get', '/requirement', /the requirement key/],
      ['forge_requirements', 'progress', '/requirement', /the requirement key/],
      ['forge_requirements', 'similar', '/text', /the wish to compare/],
      ['project_feedback', 'get', '/feedback', /the feedback key/],
      ['forge_issues', 'get', '/issue', /an issue key/],
      ['forge_releases', 'get', '/version', /forge_releases takes/],
    ] as const;
    for (const [name, action, path, says] of cases) {
      const c = await call(token, name, { action, projectId: w.projectId });
      expect(unnamed(c), `${name} ${action}: ${c.text}`).toBeNull();
      expect(c.isError, c.text).toBe(true);
      const error = c.body.error as { code: string; refusals: { path: string; detail: string }[] };
      expect(error.code, c.text).toBe('BAD_REQUEST');
      expect(error.refusals.map((r) => r.path)).toEqual([path]);
      expect(error.refusals[0]?.detail).toContain(`action ${action} needs ${path.slice(1)}`);
      expect(error.refusals[0]?.detail).toMatch(says);
      expect(c.body.detail).toMatch(new RegExp(`^${name} takes \\{ action`));
    }
  });

  it('leaves a well-formed call untouched', async () => {
    const c = await call(token, 'forge_requirements', { action: 'list', projectId: w.projectId });
    expect(c.isError, c.text).toBe(false);
    expect(Array.isArray(c.body.requirements), c.text).toBe(true);
    const absent = await call(token, 'forge_issues', {
      action: 'get',
      projectId: w.projectId,
      issue: 'ISS-999',
    });
    expect(absent.isError, absent.text).toBe(true);
    expect(absent.text).toMatch(/names no issue in this project/);
  });
});
