// The world the issue-scope tests share (REQ-36 BC-5, ISS-468): a project filing modules under
// group labels, a bare project declaring none (ISS-609), one box declaring runs over both, and the
// agent account that writes designs and moves steps. Each file calls startScopeWorld once.

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { expect } from 'vitest';
import { db } from '../../src/db/client.js';
import { api, userToken } from './api.js';
import { type Doc, startQueue, testEnv } from './ecosystem-world.js';
import {
  addProjectMember,
  bindTestRunner,
  createTestDevice,
  createTestIssue,
  createTestUser,
  seedIssueStatus,
} from './factories.js';
import { projectBuiltFrom, type Res } from './pattern-world.js';
import { declareControls } from './project-controls.js';

export let projectId = '';
/** A project that declares no module label: a design there names none and holds it whole (ISS-609). */
export let bareId = '';
export let deviceId = '';
export let adminId = '';
export let box = '';
export let author = '';

/** The module labels the wave's designs name, under the group labels this project files them in. */
const TREE: Record<string, string[]> = {
  'work-delivery': ['issues', 'lifecycle', 'pipeline'],
  'product-design': ['requirements', 'workflows', 'suggestions', 'feedback'],
  'projects-config': ['project-config'],
  execution: ['skills', 'prompt'],
  platform: ['mcp', 'db'],
};

async function moduleLabel(name: string, parentId: string | null): Promise<string> {
  const [row] = (await db.execute(sql`
    INSERT INTO labels (project_id, name, color, kind, slug, parent_id)
    VALUES (${projectId}, ${name}, '#888888', 'module', ${name}, ${parentId})
    RETURNING id
  `)) as unknown as Array<{ id: string }>;
  return String(row?.id);
}

/** The two projects, the box and the agent every scope test works in; call once per file. */
export async function startScopeWorld(): Promise<{
  projectId: string;
  bareId: string;
  deviceId: string;
  adminId: string;
  box: string;
  author: string;
}> {
  testEnv();
  await import('../../src/index.js');
  await startQueue();
  const { mintPat } = await import('../../src/credentials/pat.js');
  const admin = await createTestUser({ verified: true });
  const agent = await createTestUser({ kind: 'agent' });
  adminId = admin.id;
  projectId = await projectBuiltFrom(admin.id, null);
  for (const [group, children] of Object.entries(TREE)) {
    const parent = await moduleLabel(group, null);
    for (const child of children) await moduleLabel(child, parent);
  }
  bareId = await projectBuiltFrom(admin.id, null);
  deviceId = await createTestDevice(admin.id);
  for (const p of [projectId, bareId]) {
    // REQ-79 r6: scope_hold is strict's now; this test asks for it
    await declareControls(p, admin.id, { gates: { overrides: { scope_hold: 'enforce' } } });
    await addProjectMember(p, admin.id, 'admin');
    await addProjectMember(p, agent.id, 'member');
    await bindTestRunner(p, deviceId);
  }
  box = (
    await mintPat({
      permissions: ['*'],
      userId: admin.id,
      name: 'box-scope',
      deviceId,
      projectIds: [projectId, bareId],
    })
  ).plaintext;
  author = await userToken(agent.id);
  return { projectId, bareId, deviceId, adminId, box, author };
}

export async function call(
  token: string,
  method: 'GET' | 'POST' | 'PATCH' | 'PUT',
  path: string,
  body?: unknown,
): Promise<Res> {
  const res = await api(token, method, path, body);
  return { status: res.status, body: res.body as Doc };
}

export const details = (res: Res): string =>
  (res.body?.error?.refusals ?? []).map((r: Doc) => r.detail).join(' | ');

let seqBase = 0;

export type Issue = { id: string; key: string };

/** A fresh set of issues keyed like the wave's, each with its two criteria written, by name. */
export async function wave(...names: number[]): Promise<(n: number) => Issue> {
  return waveIn(projectId, ...names);
}

export async function waveIn(project: string, ...names: number[]): Promise<(n: number) => Issue> {
  seqBase += 1000;
  const out = new Map<number, Issue>();
  for (const n of names) {
    const issue = await createTestIssue(project, adminId, seqBase + n, {
      status: 'open',
      createdAt: new Date(),
    });
    const res = await call(author, 'PATCH', `/api/issues/${issue.id}`, {
      acceptanceCriteria: '1. It holds.\n2. It is refused by name.',
    });
    expect(res.status).toBe(200);
    out.set(n, issue);
  }
  return (n) => {
    const issue = out.get(n);
    if (!issue) throw new Error(`this wave made no issue ${n}`);
    return issue;
  };
}

/** The issue's design through the REST door, then its contracts as given. */
export async function design(
  issueId: string,
  modules: string[],
  contracts: string[] = [],
): Promise<void> {
  const res = await call(author, 'PUT', `/api/issues/${issueId}/design`, {
    criteria: [
      { criterion: 1, class: 'observable', pattern: null, proof: 'run it' },
      { criterion: 2, class: 'observable', pattern: null, proof: 'run it red' },
    ],
    modules,
    contracts: [],
  });
  expect([res.status, details(res)]).toEqual([200, '']);
  if (contracts.length > 0) {
    await db.execute(sql`
      UPDATE issue_designs SET contracts = ${sql`ARRAY[${sql.join(
        contracts.map((c) => sql`${c}`),
        sql`, `,
      )}]::text[]`} WHERE issue_id = ${issueId}`);
  }
}

/** The wave's designs: what each issue's tree and plan change, by module. */
export const DESIGNS = {
  453: ['project-config', 'requirements', 'workflows', 'suggestions', 'issues'],
  454: ['lifecycle', 'issues', 'feedback', 'pipeline'],
  455: ['pipeline', 'requirements', 'skills', 'prompt', 'mcp'],
  469: ['issues'],
} as const;

export const preflight = (keys: string[], project = projectId) =>
  call(box, 'POST', '/api/devices/me/run-sessions/preflight', {
    projectId: project,
    issueKeys: keys,
  });

export async function open(
  keys: string[],
  project = projectId,
): Promise<{ res: Res; runId: string }> {
  const runId = randomUUID();
  const res = await call(box, 'POST', '/api/devices/me/run-sessions', {
    projectId: project,
    runId,
    issueKeys: keys,
    name: keys.join(','),
  });
  return { res, runId };
}

export async function opened(
  keys: string[],
  project = projectId,
): Promise<{ sessionId: string; runId: string }> {
  const { res, runId } = await open(keys, project);
  expect([res.status, details(res)]).toEqual([200, '']);
  return { sessionId: String(res.body.sessionId), runId };
}

export const close = (sessionId: string) =>
  call(box, 'POST', `/api/devices/me/run-sessions/${sessionId}/close`, { outcome: 'ended' });

export async function admissibleKeys(): Promise<string[]> {
  const { readAdmissibleIssues } = await import('../../src/devices/admissible.js');
  const { items } = await readAdmissibleIssues({ deviceId, projectId });
  return items.map((i) => String(i.issueKey));
}

/** Ends every run still open on the bare project, so a red test leaves no holder to the next. */
export async function closeBareRuns(): Promise<void> {
  const open = (await db.execute(sql`
    SELECT s.id FROM agent_sessions s
     WHERE s.project_id = ${bareId} AND s.kind = 'run_session' AND s.status = 'running'`)) as unknown as Array<{
    id: string;
  }>;
  for (const row of open) await close(row.id);
}

/** A run declared over landed work, as the QA master's judges are: it writes no code. */
export async function landed(issueId: string): Promise<void> {
  await seedIssueStatus(issueId, 'awaiting_release');
}
