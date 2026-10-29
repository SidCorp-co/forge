/**
 * ISS-773 + ISS-767, through the real HTTP /mcp: every client is listed five tools in at most 3 KB,
 * and reaches every action through forge_find, forge_describe and forge_call — a ChatGPT session
 * finds its project, reads it and drafts a requirement in it. Projects, the project document and
 * bindings are actions over their REST services; a write needs the `write` scope and a `read` token
 * is refused naming it; `{ base, patch }` and a stale revision are refused by name; search and
 * fetch reach only projects the token reads; a secret planted in the document or a binding never
 * leaves. Each case runs with a read OAuth token, a write OAuth token or a PAT.
 */

import { createHash, randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { mintPat } from '../../src/credentials/pat.js';
import { db } from '../../src/db/client.js';
import { app } from '../../src/index.js';
import { api, userToken } from '../helpers/api.js';
import {
  addProjectMember,
  createTestIssue,
  createTestProject,
  createTestUser,
  truncateAll,
} from '../helpers/factories.js';
import { seedDeployBinding, seedProjectDocument } from '../helpers/release-world.js';

const ORIGIN = 'http://forge.test';
const REDIRECT = 'https://chatgpt.com/connector_platform_oauth_redirect';
// a GitHub token's shape, planted where a person could paste one
const PLANTED = `ghp_${'Zq7'.repeat(12)}`;

type Body = Record<string, unknown>;
let ownerId = '';
let projectId = '';
let otherProjectId = '';
let orgId = '';
let session = '';

beforeEach(async () => {
  await truncateAll();
  ownerId = (await createTestUser({ verified: true })).id;
  const made = await createTestProject(ownerId);
  projectId = made.id;
  orgId = made.orgId;
  await addProjectMember(projectId, ownerId, 'owner');
  const strangerId = (await createTestUser({ verified: true })).id;
  otherProjectId = (await createTestProject(strangerId)).id;
  await addProjectMember(otherProjectId, strangerId, 'owner');
  session = await userToken(ownerId);
  await db.execute(sql`UPDATE users SET last_fresh_auth_at = now() WHERE id = ${ownerId}`);
});

/** An access token ChatGPT's connector holds after the person consents, with the scope it asked. */
async function oauthToken(scope: 'read' | 'read write'): Promise<string> {
  const reg = await api(null, 'POST', '/api/mcp-auth/register', {
    client_name: 'ChatGPT',
    redirect_uris: [REDIRECT],
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
  });
  const clientId = reg.body.client_id as string;
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const res = await api(session, 'POST', '/api/mcp-auth/authorize', {
    client_id: clientId,
    redirect_uri: REDIRECT,
    response_type: 'code',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 's',
    scope,
    decision: 'allow',
    project_ids: [projectId],
    permissions: ['*'],
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const code = new URL(res.body.redirectTo as string).searchParams.get('code') as string;
  const pair = await app.fetch(
    new Request(`${ORIGIN}/api/mcp-auth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: clientId,
        code,
        redirect_uri: REDIRECT,
        code_verifier: verifier,
      }).toString(),
    }),
  );
  return ((await pair.json()) as Body).access_token as string;
}

const pat = async (projectIds: string[] | null) =>
  (
    await mintPat({
      permissions: ['*'],
      userId: ownerId,
      name: `mcp-773-${randomBytes(4).toString('hex')}`,
      projectIds,
    })
  ).plaintext;

async function rpc(token: string, method: string, params: Body) {
  const res = await api(
    token,
    'POST',
    '/mcp',
    { jsonrpc: '2.0', id: 1, method, params },
    { accept: 'application/json, text/event-stream' },
  );
  return res;
}

async function call(token: string, name: string, args: Body) {
  const res = await rpc(token, 'tools/call', { name, arguments: args });
  const raw = JSON.stringify(res.body);
  const result = (res.body as { result?: { content?: { text?: string }[]; isError?: boolean } })
    .result;
  const text = (result?.content ?? []).map((c) => c.text ?? '').join('\n');
  let body: Body = {};
  try {
    body = JSON.parse(result?.content?.[0]?.text ?? '') as Body;
  } catch {}
  return { status: res.status, isError: result?.isError === true, text, body, raw };
}

const act = (token: string, action: string, args: Body = {}) =>
  call(token, 'forge_call', { action, args });

describe('tools/list', () => {
  it('is the five tools in at most 3 KB, for a read token, a write token and a PAT', async () => {
    for (const token of [
      await oauthToken('read'),
      await oauthToken('read write'),
      await pat(null),
    ]) {
      const res = await rpc(token, 'tools/list', {});
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const tools = (res.body as { result: { tools: { name: string }[] } }).result.tools;
      expect(tools.map((t) => t.name)).toEqual([
        'forge_find',
        'forge_describe',
        'forge_call',
        'search',
        'fetch',
      ]);
      expect(Buffer.byteLength(JSON.stringify({ tools }))).toBeLessThanOrEqual(3 * 1024);
    }
  });
});

describe('a ChatGPT session finds its project, reads it, and drafts a requirement in it', () => {
  it('runs end to end on a write OAuth token', async () => {
    const token = await oauthToken('read write');
    const found = await call(token, 'forge_find', { query: 'list my projects' });
    expect((found.body.actions as string[]).some((a) => a.startsWith('projects.list'))).toBe(true);

    const listed = await act(token, 'projects.list');
    expect(listed.isError, listed.text).toBe(false);
    const projects = listed.body.projects as Body[];
    expect(projects.map((p) => p.id)).toEqual([projectId]);

    const got = await act(token, 'projects.get', { projectId });
    expect(got.isError, got.text).toBe(false);
    expect(got.body).toMatchObject({ id: projectId, role: 'admin' });

    const described = await call(token, 'forge_describe', { action: 'requirements.create' });
    expect((described.body.input as Body).required).toEqual(['title']);

    const created = await act(token, 'requirements.create', {
      projectId,
      title: 'Dispatchers see late orders first',
      reason: 'late orders are missed',
      criteria: [{ body: 'A late order is listed above every other order' }],
    });
    expect(created.isError, created.text).toBe(false);
    expect(created.body.created).toBe(true);
  });
});

describe('a write needs the write scope', () => {
  it('refuses a read token each write action by name, and serves it the reads', async () => {
    const token = await oauthToken('read');
    const read = await act(token, 'projects.list');
    expect(read.isError, read.raw).toBe(false);
    expect((read.body.projects as Body[]).map((p) => p.id)).toEqual([projectId]);
    for (const [action, args] of [
      ['requirements.create', { projectId, title: 'x' }],
      ['config.write', { projectId, baseRevision: null, document: {} }],
      ['projects.create', { slug: 'made-by-read', name: 'x' }],
    ] as const) {
      const r = await act(token, action, args);
      expect(r.raw, action).toMatch(/write/i);
      expect(r.raw, action).toMatch(/scope/i);
      expect(r.isError || r.status !== 200 || /error/.test(r.raw), action).toBe(true);
    }
  });
});

describe('projects.create', () => {
  it('creates on an unfenced PAT, and refuses a token fenced to projects by name', async () => {
    const made = await act(await pat(null), 'projects.create', {
      slug: 'made-by-mcp',
      name: 'Made',
      orgId,
    });
    expect(made.isError, made.text).toBe(false);
    expect(made.body).toMatchObject({ slug: 'made-by-mcp' });
    const fenced = await act(await pat([projectId]), 'projects.create', {
      slug: 'fenced-make',
      name: 'No',
    });
    expect(fenced.isError).toBe(true);
    expect(fenced.text).toMatch(/fenced|FORBIDDEN/);
  });
});

describe('the project document', () => {
  it('is read and written whole; { base, patch } and a stale revision are refused by name', async () => {
    const token = await pat(null);
    await seedProjectDocument(projectId, ownerId, { environments: {} });
    const held = await act(token, 'config.get', { projectId });
    expect(held.isError, held.text).toBe(false);
    expect(held.body).toMatchObject({ declared: true, revision: 1 });

    const patch = await act(token, 'config.write', { projectId, base: 1, patch: {} });
    expect(patch.text).toMatch(/CONFIG_WRITE_SHAPE/);

    const document = held.body.document as Body;
    const changed = {
      ...document,
      project: { ...(document.project as Body), name: 'Renamed by MCP' },
    };
    const written = await act(token, 'config.write', {
      projectId,
      baseRevision: 1,
      document: changed,
    });
    expect(written.isError, written.text).toBe(false);
    expect(written.body.revision).toBe(2);

    const stale = await act(token, 'config.write', {
      projectId,
      baseRevision: 1,
      document: changed,
    });
    expect(stale.isError).toBe(true);
    expect(stale.text).toMatch(/STALE|REVISION/);
  });
});

describe('a planted secret never leaves', () => {
  it('is scrubbed from the document, the project, a binding, search and fetch', async () => {
    const token = await pat(null);
    const document = await seedProjectDocument(projectId, ownerId, { environments: {} });
    await db.execute(sql`
      UPDATE project_config_documents
         SET document = ${JSON.stringify({
           ...document,
           project: { ...document.project, description: `deploy with ${PLANTED} on the box` },
         })}::jsonb
       WHERE project_id = ${projectId}`);
    const bindingId = await seedDeployBinding(projectId, ownerId);
    await db.execute(
      sql`UPDATE integration_bindings SET instructions = ${`use ${PLANTED}`} WHERE id = ${bindingId}`,
    );
    const issue = await createTestIssue(projectId, ownerId, 1, {
      status: 'open',
      createdAt: new Date(),
    });
    await db.execute(
      sql`UPDATE issues SET title = 'zebra crossing', description = ${`key ${PLANTED}`} WHERE id = ${issue.id}`,
    );

    const reads = [
      await act(token, 'config.get', { projectId }),
      await act(token, 'projects.get', { projectId }),
      await act(token, 'bindings.get', { projectId }),
      await act(token, 'bindings.get', { projectId, binding: bindingId }),
      await call(token, 'search', { query: 'zebra' }),
      await call(token, 'fetch', { id: `issue:${issue.id}` }),
    ];
    for (const r of reads) {
      expect(r.raw).not.toContain(PLANTED);
    }
    const stored = await db.execute(
      sql`SELECT instructions FROM integration_bindings WHERE id = ${bindingId}`,
    );
    expect(JSON.stringify(stored)).toContain(PLANTED);
    expect(((reads[4]?.body.results ?? []) as Body[]).map((r) => r.id)).toEqual([
      `issue:${issue.id}`,
    ]);
    expect(reads[5]?.body).toMatchObject({ id: `issue:${issue.id}`, metadata: { key: 'ISS-1' } });
  });
});

describe('search and fetch reach only projects the token reads', () => {
  it('neither lists nor fetches an item of a project the token cannot read', async () => {
    const token = await oauthToken('read');
    const strangerId = (
      (await db.execute(
        sql`SELECT created_by FROM projects WHERE id = ${otherProjectId}`,
      )) as unknown as {
        created_by: string;
      }[]
    )[0]?.created_by as string;
    const hidden = await createTestIssue(otherProjectId, strangerId, 1, {
      status: 'open',
      createdAt: new Date(),
    });
    await db.execute(sql`UPDATE issues SET title = 'zebra hidden' WHERE id = ${hidden.id}`);
    const searched = await call(token, 'search', { query: 'zebra' });
    expect(searched.isError, searched.text).toBe(false);
    expect(searched.body.results).toEqual([]);
    const fetched = await call(token, 'fetch', { id: `issue:${hidden.id}` });
    expect(fetched.isError).toBe(true);
    expect(fetched.text).toMatch(/MCP_FETCH_NOT_FOUND/);
  });
});
