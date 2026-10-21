/**
 * The product tools on /mcp, through the transport a BA's MCP client speaks: forge_requirements and
 * project_feedback read, write and refuse as their REST twins do, and every requirement and feedback
 * answer carries the progress block — whether work runs now, what waits on whom, and the forecast
 * ETA or why there is none (owner rule 2026-10-16).
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { mintPat } from '../../src/credentials/pat.js';
import { db } from '../../src/db/client.js';
import { api, type Body, patToken } from '../helpers/api.js';
import {
  ago,
  feedback,
  issue,
  landHistory,
  requirement,
  type World,
  world,
} from '../helpers/forecast-world.js';

interface Called {
  isError: boolean;
  text: string;
  body: Body;
}

async function call(token: string, name: string, args: Record<string, unknown>): Promise<Called> {
  const res = await api(
    token,
    'POST',
    '/mcp',
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
    { accept: 'application/json, text/event-stream' },
  );
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const result = (res.body as { result: { content: { text: string }[]; isError?: boolean } })
    .result;
  const text = result.content[0]?.text ?? '';
  let body: Body = {};
  try {
    body = JSON.parse(text) as Body;
  } catch {}
  return { isError: result.isError === true, text, body };
}

const ok = (c: Called): Body => {
  expect(c.isError, c.text).toBe(false);
  return c.body;
};

/** A run a box declared over `issueKey` right now: its run session started a moment ago and beats. */
async function workingRun(w: World, issueKey: string): Promise<void> {
  const runId = randomUUID();
  const metadata = JSON.stringify({ type: 'run_session', runGroup: [issueKey] });
  await db.execute(sql`
    INSERT INTO pipeline_runs (id, project_id, kind, status, started_at, metadata)
    VALUES (${runId}, ${w.projectId}, 'system', 'running', now(), ${metadata}::jsonb)
  `);
  await db.execute(sql`
    INSERT INTO agent_sessions (project_id, device_id, pipeline_run_id, kind, status, started_at, created_at, last_heartbeat_at)
    VALUES (${w.projectId}, ${w.deviceId}, ${runId}, 'run_session', 'running', now(), now(), now())
  `);
}

/** Agrees `requirementId` at a revision 1 its author wrote, through the kernel's marker. */
async function agreed(w: World, requirementId: string): Promise<void> {
  const { withKernelMarker } = await import('../../src/db/kernel-marker.js');
  await withKernelMarker(db, async (tx) => {
    await tx.execute(sql`
      INSERT INTO requirement_revisions
        (requirement_id, revision, state, spec, reason, author_id, author_agency, decided_by, decided_at)
      VALUES (${requirementId}, 1, 'current', '{}'::jsonb, 'first cut', ${w.userId}, 'human', ${w.userId}, now())
    `);
    await tx.execute(
      sql`UPDATE requirements SET current_revision = 1, status = 'agreed' WHERE id = ${requirementId}`,
    );
  });
}

const progressOf = (b: Body) => b.progress as Body;
const etaOf = (b: Body) => progressOf(b).eta as Body;

describe('forge_requirements over /mcp', () => {
  let w: World;
  let token: string;
  let readOnly: string;
  const req = { running: '', idle: '' };
  let runningIssue = '';

  beforeAll(async () => {
    w = await world();
    token = await patToken(w.userId, [w.projectId]);
    readOnly = (
      await mintPat({
        permissions: ['projects:read'],
        userId: w.userId,
        name: 'read only',
        projectIds: [w.projectId],
      })
    ).plaintext;
    await landHistory(w, 20);
    const running = await requirement(w, 'Invoices export to CSV');
    await agreed(w, running.id);
    const work = await issue(w, {
      status: 'in_progress',
      createdAt: ago(2),
      requirementId: running.id,
    });
    await workingRun(w, work.key);
    req.running = running.key;
    runningIssue = work.key;
    req.idle = (await requirement(w, 'Reports in Vietnamese')).key;
  }, 180_000);

  it('lists every requirement, each with a progress block', async () => {
    const listed = ok(
      await call(token, 'forge_requirements', { action: 'list', projectId: w.projectId }),
    );
    const rows = listed.requirements as Body[];
    expect(rows.map((r) => r.key).sort()).toEqual([req.running, req.idle].sort());
    for (const r of rows) {
      expect(progressOf(r)).toMatchObject({ label: 'forecast', running: expect.any(Boolean) });
      expect(typeof progressOf(r).says).toBe('string');
      expect(etaOf(r)).toHaveProperty('estimate');
    }
  });

  it('says the work running now and dates it from the project’s history', async () => {
    const got = ok(
      await call(token, 'forge_requirements', {
        action: 'get',
        projectId: w.projectId,
        requirement: req.running,
      }),
    ).requirement as Body;
    const p = progressOf(got);
    expect(p.running).toBe(true);
    expect(p.runs).toEqual([expect.objectContaining({ issue: runningIssue, state: 'running' })]);
    expect(p.says).toMatch(new RegExp(`^Running now: ${runningIssue} `));
    expect(etaOf(got)).toMatchObject({
      estimate: true,
      likelyBy: expect.any(String),
      almostSurelyBy: expect.any(String),
    });
    expect(p.work).toMatchObject({ total: 1, toDo: 1 });
  });

  it('states why a draft has no estimate, never a date', async () => {
    const p = ok(
      await call(token, 'forge_requirements', {
        action: 'progress',
        projectId: w.projectId,
        requirement: req.idle,
      }),
    ).progress as Body;
    expect(p.running).toBe(false);
    expect(p.eta).toEqual({
      estimate: false,
      done: false,
      why: 'it is a draft, and issues are planned only after a person agrees it',
    });
    expect(p.says).toContain('No estimate: it is a draft');
  });

  it('drafts a requirement from a title, revises the draft and proposes it', async () => {
    const created = ok(
      await call(token, 'forge_requirements', {
        action: 'create',
        projectId: w.projectId,
        title: 'Dispatchers see late orders first',
        reason: 'late orders are missed',
        criteria: [{ body: 'A late order is listed above every other order' }],
      }),
    );
    expect(created.created).toBe(true);
    const made = created.requirement as Body;
    expect(made).toMatchObject({ state: 'draft', openRevision: { revision: 1, state: 'draft' } });
    expect(etaOf(made)).toMatchObject({ estimate: false });

    const revised = ok(
      await call(token, 'forge_requirements', {
        action: 'revise',
        projectId: w.projectId,
        requirement: made.key,
        revision: 1,
        reason: 'late orders are missed',
        criteria: [
          { code: 'BC-1', body: 'A late order is listed above every other order' },
          { body: 'A late order shows how late it is' },
        ],
      }),
    ).requirement as Body;
    expect((revised.revision as Body).criteria).toHaveLength(2);

    const proposed = ok(
      await call(token, 'forge_requirements', {
        action: 'propose',
        projectId: w.projectId,
        requirement: made.key,
        revision: 1,
      }),
    ).requirement as Body;
    expect(proposed.openRevision).toEqual({ revision: 1, state: 'proposed' });
  });

  it('refuses a revise that names no base, by the field', async () => {
    const c = await call(token, 'forge_requirements', {
      action: 'revise',
      projectId: w.projectId,
      requirement: req.idle,
      criteria: [],
    });
    expect(c.isError).toBe(true);
    expect(c.text).toMatch(/baseRevision is required for revise/);
  });

  it('answers NOT_FOUND for a key the project does not hold', async () => {
    const c = await call(token, 'forge_requirements', {
      action: 'get',
      projectId: w.projectId,
      requirement: 'REQ-999',
    });
    expect(c.isError).toBe(true);
    expect(c.text).toMatch(/holds no requirement REQ-999/);
  });

  it('refuses a write to a token granted projects:read, and lets it read', async () => {
    const c = await call(readOnly, 'forge_requirements', {
      action: 'create',
      projectId: w.projectId,
      title: 'Never written',
    });
    expect(c.isError).toBe(true);
    expect(c.text).toMatch(/projects:write/);
    ok(await call(readOnly, 'forge_requirements', { action: 'list', projectId: w.projectId }));
  });
});

describe('project_feedback over /mcp', () => {
  let w: World;
  let token: string;
  const fb = { untriaged: '', linked: '' };
  let linkedIssue = '';

  beforeAll(async () => {
    w = await world();
    token = await patToken(w.userId, [w.projectId]);
    await landHistory(w, 20);
    const work = await issue(w, { status: 'in_progress', createdAt: ago(1) });
    await workingRun(w, work.key);
    linkedIssue = work.key;
    fb.untriaged = await feedback(w);
    fb.linked = await feedback(w, [work.id]);
  }, 180_000);

  it('lists items with progress: untriaged waits on its triage, routed work runs', async () => {
    const rows = ok(
      await call(token, 'project_feedback', { action: 'list', projectId: w.projectId }),
    ).feedback as Body[];
    const untriaged = rows.find((r) => r.key === fb.untriaged) as Body;
    expect(etaOf(untriaged)).toEqual({
      estimate: false,
      done: false,
      why: 'it is not triaged yet',
    });
    expect(progressOf(untriaged).waitingOn).toEqual(
      expect.arrayContaining([expect.objectContaining({ act: 'triage it' })]),
    );
    const linked = rows.find((r) => r.key === fb.linked) as Body;
    expect(progressOf(linked)).toMatchObject({ running: true });
    expect(progressOf(linked).runs).toEqual([expect.objectContaining({ issue: linkedIssue })]);
    expect(etaOf(linked)).toMatchObject({ estimate: true });
  });

  it('files an item, asks its reporter, and refuses a second open question by name', async () => {
    const filed = ok(
      await call(token, 'project_feedback', {
        action: 'submit',
        projectId: w.projectId,
        kind: 'bug',
        title: 'The export button does nothing',
        screen: 'Invoices',
      }),
    );
    expect(filed.created).toBe(true);
    const item = filed.feedback as Body;
    expect(item).toMatchObject({ phase: 'new' });
    expect(etaOf(item)).toMatchObject({ estimate: false, why: 'it is not triaged yet' });

    const asked = ok(
      await call(token, 'project_feedback', {
        action: 'clarify',
        projectId: w.projectId,
        feedback: item.key,
        prompt: 'Which browser were you using?',
        needed: 'the browser and its version',
      }),
    ).feedback as Body;
    expect(asked.clarification).toMatchObject({ status: 'open' });

    const again = await call(token, 'project_feedback', {
      action: 'clarify',
      projectId: w.projectId,
      feedback: item.key,
      prompt: 'And which page?',
      needed: 'the page',
    });
    expect(again.isError).toBe(true);
    expect(again.text).toMatch(/FEEDBACK_CLARIFICATION_ALREADY_OPEN/);
  });

  it('refuses a submit naming no target, saying the shape', async () => {
    const c = await call(token, 'project_feedback', {
      action: 'submit',
      projectId: w.projectId,
      kind: 'idea',
      title: 'Dark mode',
    });
    expect(c.isError).toBe(true);
    expect(c.text).toMatch(/requirement|target/i);
  });

  it('reads one item and its similar ones', async () => {
    const got = ok(
      await call(token, 'project_feedback', {
        action: 'get',
        projectId: w.projectId,
        feedback: fb.linked,
      }),
    ).feedback as Body;
    expect(got).toMatchObject({ key: fb.linked, route: { route: 'issue' } });
    expect(progressOf(got).running).toBe(true);
    const similar = ok(
      await call(token, 'project_feedback', {
        action: 'similar',
        projectId: w.projectId,
        feedback: fb.linked,
      }),
    );
    expect(similar.status).toEqual(expect.any(String));
  });
});
