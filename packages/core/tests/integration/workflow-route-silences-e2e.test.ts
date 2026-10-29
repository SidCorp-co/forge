/**
 * Two silences on the workflow routes, each answered by name (ISS-581, ISS-565):
 * the single read refuses a query it does not read instead of serving the head as if `revision` had
 * been honoured, and a write that proposes nothing lists the `issue` it did not use under `ignored`
 * instead of answering as though the issue were recorded.
 */

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { api, patToken } from '../helpers/api.js';
import {
  closeWorld,
  type Doc,
  ok,
  type Reply,
  requester,
  settleOutbox,
  startQueue,
  testEnv,
} from '../helpers/ecosystem-world.js';
import { addProjectMember, createTestProject, createTestUser } from '../helpers/factories.js';

let projectId: string;
let ownerId: string;
let ownerPat: string;
let say: (who: 'owner' | 'master', method: string, path: string, body?: Doc) => Promise<Reply>;

const design = (flow: string): Doc => {
  const d = JSON.parse(
    readFileSync(
      new URL('../fixtures/workflows/post-discharge.design.json', import.meta.url),
      'utf8',
    ),
  );
  d.project = projectId;
  d.flow = flow;
  return d;
};

beforeAll(async () => {
  testEnv();
  const { app } = await import('../../src/index.js');
  await startQueue();
  const { signUserToken } = await import('../../src/credentials/jwt.js');
  const { mintPat } = await import('../../src/credentials/pat.js');
  ownerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  ownerPat = await patToken(ownerId, [projectId], 'mcp-owner');
  const agentId = (await createTestUser({ kind: 'agent' })).id;
  await addProjectMember(projectId, agentId, 'member');
  say = requester(app, {
    owner: await signUserToken(ownerId),
    master: (
      await mintPat({
        permissions: ['*'],
        userId: agentId,
        name: 'master',
        projectIds: [projectId],
      })
    ).plaintext,
  });
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

beforeEach(async () => {
  await settleOutbox();
});

const at = (path: string) => `/api/projects/${projectId}${path}`;
const refusalsOf = (r: Reply): Doc[] => r.json.error?.refusals ?? [];

let seq = 900;
async function plantIssue(): Promise<{ id: string; key: string }> {
  const id = randomUUID();
  seq += 1;
  const { withKernelMarker } = await import('../../src/db/kernel-marker.js');
  await withKernelMarker(db, (tx) =>
    tx.execute(sql`
      INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id)
      VALUES (${id}, ${projectId}, ${seq}, 'planted in_progress', 'in_progress', ${ownerId})
    `),
  );
  return { id, key: `ISS-${seq}` };
}

async function draft(flow: string): Promise<string> {
  const made = ok(
    await say('master', 'POST', at('/workflows'), { baseRevision: null, document: design(flow) }),
    201,
  );
  return made.document.id as string;
}

/** The document as GET answers it, without the stamps a write does not take. */
async function current(id: string): Promise<{ revision: number; doc: Doc }> {
  const read = ok(await say('master', 'GET', at(`/workflows/${id}`)));
  const { id: _id, createdAt, updatedAt, ...doc } = read.document;
  void _id;
  void createdAt;
  void updatedAt;
  return { revision: read.revision, doc };
}

async function put(id: string, edit: (d: Doc) => void, issue: string): Promise<Reply> {
  const { revision, doc } = await current(id);
  edit(doc);
  return say('master', 'PUT', at(`/workflows/${id}`), {
    baseRevision: revision,
    document: doc,
    issue,
  });
}

const ignoredIssue = (r: Reply) =>
  (r.json.ignored as { path: string; detail: string }[] | undefined)?.find(
    (i) => i.path === '/issue',
  );

describe('ISS-581: the single workflow read refuses a query it does not read', () => {
  it('refuses `revision`, naming where a past revision is read', async () => {
    const id = await draft('read-revision');
    await put(
      id,
      (d) => {
        d.summary = `${d.summary} (second)`;
      },
      (await plantIssue()).key,
    );
    const res = await say('master', 'GET', at(`/workflows/${id}?revision=1`));
    expect(res.status).toBe(400);
    const [row] = refusalsOf(res);
    expect(row).toMatchObject({ code: 'UNKNOWN_QUERY_PARAMETER', path: '/revision' });
    expect(row?.detail).toContain('/design?view=steps&revision=');
    expect(row?.detail).toContain('/system-graph?revision=');
    expect(res.json.code).toBe('UNKNOWN_QUERY_PARAMETER');
  });

  it('refuses an unknown key by name, and answers the head with no query', async () => {
    const id = await draft('read-unknown');
    const res = await say('master', 'GET', at(`/workflows/${id}?bogus=1`));
    expect(res.status).toBe(400);
    expect(refusalsOf(res)).toEqual([
      expect.objectContaining({ code: 'UNKNOWN_QUERY_PARAMETER', path: '/bogus' }),
    ]);
    expect(res.json.detail).toContain('`bogus`');
    expect(res.json.detail).toContain('This route takes no query parameters.');
    await put(
      id,
      (d) => {
        d.summary = `${d.summary} (head)`;
      },
      (await plantIssue()).key,
    );
    const head = ok(await say('master', 'GET', at(`/workflows/${id}`)));
    expect(head.revision).toBe(2);
    expect(head.document.summary).toContain('(head)');
  });

  it('refuses a key on the reads beside it that take no query', async () => {
    const id = await draft('read-siblings');
    for (const path of [
      `/workflows/${id}/health`,
      `/workflows/${id}/design/repins`,
      `/workflows/${id}/observations`,
      '/workflow-templates',
    ]) {
      const res = await say('master', 'GET', at(`${path}?bogus=1`));
      expect(res.status, path).toBe(400);
      expect(refusalsOf(res)[0], path).toMatchObject({
        code: 'UNKNOWN_QUERY_PARAMETER',
        path: '/bogus',
      });
    }
  });
});

describe('ISS-565: a workflow write that proposes nothing lists the issue it did not use', () => {
  it('lists `/issue` under `ignored` on an unchanged document', async () => {
    const id = await draft('unchanged-issue');
    const issue = await plantIssue();
    const res = await put(id, () => {}, issue.key);
    expect(res.status).toBe(200);
    expect(res.json.created).toBe(false);
    expect(res.json.revision).toBe(1);
    expect(ignoredIssue(res)?.detail).toContain('unchanged');
  });

  it('lists `/issue` under `ignored` on a draft change, and draws a proposing write under it', async () => {
    const id = await draft('draft-issue');
    const issue = await plantIssue();
    const drafted = await put(
      id,
      (d) => {
        d.summary = `${d.summary} (draft edit)`;
      },
      issue.key,
    );
    expect(drafted.status).toBe(200);
    expect(drafted.json.revision).toBe(2);
    expect(drafted.json.design.status).toBe('draft');
    expect(ignoredIssue(drafted)?.detail).toContain('proposes no design');

    ok(
      await say('master', 'POST', at(`/workflows/${id}/design/propose`), {
        revision: 2,
        issue: issue.key,
      }),
    );
    const proposing = await put(
      id,
      (d) => {
        d.summary = `${d.summary} (revised)`;
      },
      issue.key,
    );
    expect(proposing.status).toBe(200);
    expect(proposing.json.design.status).toBe('proposed');
    expect(ignoredIssue(proposing)).toBeUndefined();
    const read = ok(await say('owner', 'GET', at(`/workflows/${id}/design`)));
    expect(read.revisions[0]).toMatchObject({ revision: 3, designIssueId: issue.id });
  });

  it('lists `/issue` under `ignored` on the MCP design_revise write as REST does', async () => {
    const id = await draft('mcp-unchanged-issue');
    const issue = await plantIssue();
    const { revision, doc } = await current(id);
    const res = await api(
      ownerPat,
      'POST',
      '/mcp',
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'forge_design',
          arguments: {
            action: 'design_revise',
            projectId,
            workflowId: id,
            body: { baseRevision: revision, document: doc, issue: issue.key },
          },
        },
      },
      { accept: 'application/json, text/event-stream' },
    );
    expect(res.status).toBe(200);
    const result = res.body.result as { content: { text: string }[]; isError?: boolean };
    expect(result.isError ?? false, result.content[0]?.text).toBe(false);
    const answer = JSON.parse(result.content[0]?.text ?? '{}') as Doc;
    expect(answer.created).toBe(false);
    expect(ignoredIssue({ status: 200, json: answer })?.detail).toContain('unchanged');
  });
});
