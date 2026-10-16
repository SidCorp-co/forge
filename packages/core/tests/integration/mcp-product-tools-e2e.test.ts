/**
 * The product layer on core's MCP server (2026-10-16: a person works the product from an MCP client,
 * delivery stays off it). Through `/mcp` with a token, against real Postgres: releases read with what
 * is running and when it is likely done, named, and decided by the version a person reads; designs
 * written, proposed and decided only by their approver; questions read, a person's question refused a
 * token's answer as REST refuses it, and a question raised on an issue; issues read with their
 * progress, and an issue never filed from here — the refusal says where the record goes instead.
 */

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { api, patToken } from '../helpers/api.js';
import { closeWorld, settleOutbox, startQueue, testEnv } from '../helpers/ecosystem-world.js';
import {
  addProjectMember,
  createTestIssue,
  createTestProject,
  createTestUser,
  rows,
} from '../helpers/factories.js';
import {
  declareProductionDocument,
  releaseWorld,
  seedProjectDocument,
} from '../helpers/release-world.js';

type Json = Record<string, unknown>;
type Answer = { isError: boolean; text: string; json: Json };

const BETA_SHA = 'e7af41887a0e90ed541bb0dbfb34d4f9cb4f8510';

let projectId: string;
let ownerId: string;
const tokens = { owner: '', agent: '', member: '', viewer: '' };
const fx = releaseWorld(() => ({ projectId, ownerId }));

beforeAll(async () => {
  testEnv();
  await startQueue();
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

beforeEach(async () => {
  await settleOutbox();
  ownerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  tokens.owner = await patToken(ownerId, [projectId], 'mcp-owner');
  const agentId = (await createTestUser({ kind: 'agent' })).id;
  await addProjectMember(projectId, agentId, 'admin');
  tokens.agent = await patToken(agentId, [projectId], 'release');
  const memberId = (await createTestUser({ verified: true })).id;
  await addProjectMember(projectId, memberId, 'member');
  tokens.member = await patToken(memberId, [projectId], 'mcp-member');
  const viewerId = (await createTestUser({ verified: true })).id;
  await addProjectMember(projectId, viewerId, 'viewer');
  tokens.viewer = await patToken(viewerId, [projectId], 'mcp-viewer');
});

async function mcp(who: keyof typeof tokens, name: string, args: Json): Promise<Answer> {
  const res = await api(
    tokens[who],
    'POST',
    '/mcp',
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
    { accept: 'application/json, text/event-stream' },
  );
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const result = res.body.result as { content: { text: string }[]; isError?: boolean };
  const text = result.content[0]?.text ?? '';
  let json: Json = {};
  try {
    json = JSON.parse(text) as Json;
  } catch {}
  return { isError: result.isError === true, text, json };
}

const ok = (a: Answer): Json => {
  expect(a.isError, a.text).toBe(false);
  return a.json;
};
const codeOf = (a: Answer) => {
  expect(a.isError, a.text).toBe(true);
  return (a.json.error as { code?: string } | undefined)?.code ?? a.text;
};

describe('the product tools are listed for an MCP client', () => {
  it('lists releases, design, questions and issues beside the uploads, and no delivery tool', async () => {
    const res = await api(
      tokens.owner,
      'POST',
      '/mcp',
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      { accept: 'application/json, text/event-stream' },
    );
    const listed = (res.body.result as { tools: { name: string; description: string }[] }).tools;
    expect(listed.map((t) => t.name).sort()).toEqual(
      expect.arrayContaining(['forge_design', 'forge_issues', 'forge_questions', 'forge_releases']),
    );
    expect(listed.map((t) => t.name)).not.toContain('forge_coolify_deploy');
    const issues = listed.find((t) => t.name === 'forge_issues');
    expect(issues?.description).toContain('MCP_FILES_FEEDBACK_NOT_ISSUES');
  });
});

describe('forge_releases', () => {
  beforeEach(async () => {
    await fx.seedReleaseRunner();
    const bindingId = await fx.declareProduction({}, 'none');
    await declareProductionDocument({
      projectId,
      ownerId,
      bindingId,
      probes: 'none',
      others: { beta: { tier: 'staging', deployment: { mode: 'external' } } },
    });
  });

  /** A batch cut by the owner over REST, and the release run asking for its approval. */
  async function waitingOnApproval(): Promise<{ runId: string; approvalId: string }> {
    const issueId = await fx.insertIssue('awaiting_release', { section: 'Added', userFacing: 'A' });
    const cut = await api(tokens.owner, 'POST', `/api/projects/${projectId}/release-batches`, {
      issueIds: [issueId],
    });
    expect(cut.status, JSON.stringify(cut.body)).toBe(201);
    const runId = String(cut.body.runId);
    const asked = await api(
      tokens.agent,
      'POST',
      `/api/projects/${projectId}/release-batches/${runId}/approvals`,
      { evidence: { environment: 'beta', commit: BETA_SHA, reading: 'GET /api/health 200' } },
    );
    expect(asked.status, JSON.stringify(asked.body)).toBe(201);
    return { runId, approvalId: String(asked.body.id) };
  }

  const decisionOf = async (approvalId: string) =>
    (
      await rows<{ decision: string | null }>(
        sql`SELECT decision FROM release_approvals WHERE id = ${approvalId}`,
      )
    )[0]?.decision ?? null;

  it('lists the draft with how far it is, whether an agent works on it, and when it is likely done', async () => {
    await fx.insertIssue('awaiting_release', { section: 'Added', userFacing: 'A' });
    const listed = ok(await mcp('member', 'forge_releases', { action: 'list', projectId }));
    const draft = listed.draft as { version: string; progress: Json };
    expect(draft.progress.running).toBe(false);
    expect(draft.progress.says).toContain(
      '0 of 1 issue(s) still to land, 1 landed and waiting for a release, 0 shipped.',
    );
    const row = (listed.releases as Json[]).find((r) => r.state === 'draft');
    expect(row?.version).toBe(draft.version);
    expect(row?.progress).toEqual(draft.progress);
    const got = ok(
      await mcp('member', 'forge_releases', { action: 'get', projectId, version: draft.version }),
    );
    expect(got.state).toBe('draft');
    expect((got.progress as Json).says).toBe(draft.progress.says);
  });

  it('names a drafted release for a project admin, and refuses a member by the permission', async () => {
    await fx.insertIssue('awaiting_release', { section: 'Added', userFacing: 'A' });
    const listed = ok(await mcp('owner', 'forge_releases', { action: 'list', projectId }));
    const version = String((listed.draft as Json).version);
    const naming = { name: 'Faster checkout', summary: 'Checkout takes one step. It is faster.' };
    const refused = await mcp('member', 'forge_releases', {
      action: 'name',
      projectId,
      version,
      ...naming,
    });
    expect(codeOf(refused)).toBe('PERMISSION_FORBIDDEN');
    const named = ok(
      await mcp('owner', 'forge_releases', { action: 'name', projectId, version, ...naming }),
    );
    expect(named).toMatchObject({ version, state: 'draft', name: 'Faster checkout' });
    const got = ok(await mcp('member', 'forge_releases', { action: 'get', projectId, version }));
    expect(got.name).toBe('Faster checkout');
  });

  it('decides the approval a release waits on by its version, once, and only for an approver', async () => {
    const { approvalId } = await waitingOnApproval();
    const waiting = ok(
      await mcp('owner', 'forge_releases', { action: 'get', projectId, version: '0.1.0' }),
    );
    expect(waiting.state).toBe('awaiting_approval');
    expect(waiting.progress).toMatchObject({ running: false, eta: null });
    expect((waiting.progress as Json).says).toContain('No date while it waits.');

    const byMember = await mcp('member', 'forge_releases', {
      action: 'decide',
      projectId,
      version: '0.1.0',
      decision: 'return',
      reason: 'not mine to say',
    });
    expect(codeOf(byMember)).toBe('PERMISSION_FORBIDDEN');
    expect(byMember.text).toContain('releases.approve');
    expect(await decisionOf(approvalId)).toBeNull();

    const noReason = await mcp('owner', 'forge_releases', {
      action: 'decide',
      projectId,
      version: '0.1.0',
      decision: 'return',
    });
    expect(codeOf(noReason)).toBe('RELEASE_RETURN_WITHOUT_REASON');

    const returned = ok(
      await mcp('owner', 'forge_releases', {
        action: 'decide',
        projectId,
        version: '0.1.0',
        decision: 'return',
        reason: 'beta still serves the old build',
      }),
    );
    expect(returned).toMatchObject({ act: 'return', version: '0.1.0' });
    expect((returned.approval as Json).decision).toBe('returned');
    expect(await decisionOf(approvalId)).toBe('returned');

    const again = await mcp('owner', 'forge_releases', {
      action: 'decide',
      projectId,
      version: '0.1.0',
      decision: 'return',
      reason: 'twice',
    });
    expect(codeOf(again)).toBe('RELEASE_APPROVAL_NOT_PENDING');
  });

  it('refuses a decision on a version nobody cut, and a decision a token may not take', async () => {
    const unknown = await mcp('owner', 'forge_releases', {
      action: 'decide',
      projectId,
      version: '9.9.9',
      decision: 'approve',
    });
    expect(codeOf(unknown)).toBe('RELEASE_VERSION_UNKNOWN');
    const missing = await mcp('owner', 'forge_releases', { action: 'get', projectId });
    expect(codeOf(missing)).toBe('BAD_REQUEST');
    expect(missing.text).toContain('action get needs version');
  });
});

describe('forge_questions', () => {
  let issue: { id: string; key: string };
  let questionId: string;

  beforeEach(async () => {
    questionId = randomUUID();
    issue = await createTestIssue(projectId, ownerId, 50, {
      status: 'in_progress',
      createdAt: new Date(Date.now() - 3_600_000),
    });
    const { askQuestion } = await import('../../src/questions/index.js');
    await askQuestion({
      id: questionId,
      projectId,
      issueId: issue.id,
      prompt: 'Which flag guards the tour?',
      blockerKind: 'human',
      answer: { shape: 'free_text', needed: 'the flag', recommended: 'tours.v2' },
    });
  });

  it('lists what is owed and reads one with the progress of the issue it parks', async () => {
    const listed = ok(await mcp('member', 'forge_questions', { action: 'list', projectId }));
    expect((listed.questions as Json[]).map((q) => q.id)).toEqual([questionId]);
    const got = ok(
      await mcp('member', 'forge_questions', { action: 'get', projectId, questionId }),
    );
    expect((got.question as Json).prompt).toBe('Which flag guards the tour?');
    const progress = got.progress as Json;
    expect(progress.issue).toBe(issue.key);
    expect(progress.running).toBe(false);
    expect(typeof progress.says).toBe('string');
  });

  it("refuses a token's answer to a person's question as REST does, and leaves it open", async () => {
    const answered = await mcp('owner', 'forge_questions', {
      action: 'answer',
      projectId,
      questionId,
      round: 1,
      text: 'tours.v2',
    });
    expect(answered.isError).toBe(true);
    expect(answered.text).toContain('a question is answered by a person in a session');
    const [row] = await rows<{ status: string }>(
      sql`SELECT status FROM agent_questions WHERE id = ${questionId}`,
    );
    expect(row?.status).toBe('open');
  });

  it("does not read another project's question under this one", async () => {
    const otherId = (await createTestProject(ownerId)).id;
    const outside = await api(tokens.owner, 'GET', `/api/questions/${questionId}`);
    expect(outside.status).toBe(200);
    const res = await mcp('owner', 'forge_questions', {
      action: 'get',
      projectId: otherId,
      questionId,
    });
    expect(res.isError).toBe(true);
  });

  it('raises a person’s question on an issue as a question comment, and refuses a viewer', async () => {
    const asked = ok(
      await mcp('member', 'forge_questions', {
        action: 'ask',
        projectId,
        issue: issue.key,
        body: 'Does the tour show on mobile too?',
      }),
    );
    expect(asked.act).toBe('asked');
    const [comment] = await rows<{ intent: string; body: string }>(
      sql`SELECT intent, body FROM comments WHERE issue_id = ${issue.id}`,
    );
    expect(comment).toEqual({ intent: 'question', body: 'Does the tour show on mobile too?' });
    const byViewer = await mcp('viewer', 'forge_questions', {
      action: 'ask',
      projectId,
      issue: issue.key,
      body: 'Me too?',
    });
    expect(codeOf(byViewer)).toBe('PERMISSION_FORBIDDEN');
  });
});

describe('forge_issues', () => {
  const issueCount = async () =>
    Number((await rows<{ n: string }>(sql`SELECT count(*)::text AS n FROM issues`))[0]?.n ?? 'NaN');

  it('reads issues with their progress, and one with the questions it waits on', async () => {
    const issue = await createTestIssue(projectId, ownerId, 7, {
      status: 'open',
      createdAt: new Date(Date.now() - 600_000),
    });
    const listed = ok(await mcp('viewer', 'forge_issues', { action: 'list', projectId }));
    const [row] = listed.issues as Json[];
    expect(row).toMatchObject({
      key: issue.key,
      status: 'open',
      progress: { running: false, says: expect.any(String) },
    });
    const got = ok(
      await mcp('viewer', 'forge_issues', { action: 'get', projectId, issue: issue.key }),
    );
    expect(got).toMatchObject({ key: issue.key, openQuestions: [] });
    expect((got.progress as Json).says).toEqual(expect.any(String));
  });

  it('files no issue: create is refused by name with where the record goes instead', async () => {
    const before = await issueCount();
    const refused = await mcp('owner', 'forge_issues', {
      action: 'create',
      projectId,
      title: 'Login is broken on Safari',
    });
    expect(codeOf(refused)).toBe('MCP_FILES_FEEDBACK_NOT_ISSUES');
    expect((refused.json as { status?: number }).status).toBe(403);
    expect(refused.text).toContain('forge_feedback');
    expect(refused.text).toContain('forge_requirements');
    expect(await issueCount()).toBe(before);
  });
});

describe('forge_design', () => {
  const design = (): Json =>
    JSON.parse(
      readFileSync(
        new URL('../fixtures/workflows/post-discharge.design.json', import.meta.url),
        'utf8',
      ),
    ) as Json;

  beforeEach(async () => {
    await seedProjectDocument(projectId, ownerId, {
      environments: {},
      source: { type: 'none' },
      extra: { approvals: { designs: true } },
    });
  });

  it('writes and proposes a design; where designs need approval, only its approver decides', async () => {
    expect(ok(await mcp('member', 'forge_design', { action: 'design_list', projectId }))).toEqual({
      workflows: [],
      returned: 0,
    });
    const document = { ...design(), project: projectId, flow: 'mcp-flow' };
    const made = ok(
      await mcp('member', 'forge_design', {
        action: 'design_create',
        projectId,
        body: { baseRevision: null, document },
      }),
    );
    expect(made.created).toBe(true);
    const workflowId = String((made.document as Json).id);
    const proposed = ok(
      await mcp('member', 'forge_design', {
        action: 'design_propose',
        projectId,
        workflowId,
        revision: 1,
      }),
    );
    expect(proposed.proposedRevision).toBe(1);

    const byMember = await mcp('member', 'forge_design', {
      action: 'design_decide',
      projectId,
      workflowId,
      revision: 1,
      decision: 'approve',
    });
    expect(byMember.isError).toBe(true);
    expect(byMember.text).toContain('workflow-designs.approve');

    const read = ok(
      await mcp('member', 'forge_design', { action: 'design_get', projectId, workflowId }),
    );
    expect(read.proposedRevision).toBe(1);
    expect((read.progress as Json).eta).toContain('no forecast of its own');

    const approved = ok(
      await mcp('owner', 'forge_design', {
        action: 'design_decide',
        projectId,
        workflowId,
        revision: 1,
        decision: 'approve',
      }),
    );
    expect(approved.approvedRevision).toBe(1);
  });

  it('lists suggestions and mockups, and refuses a call missing what its action needs', async () => {
    const listed = ok(
      await mcp('member', 'forge_design', { action: 'suggestion_list', projectId }),
    );
    expect(listed.suggestions).toEqual([]);
    const missing = await mcp('member', 'forge_design', { action: 'suggestion_accept', projectId });
    expect(codeOf(missing)).toBe('BAD_REQUEST');
    expect(missing.text).toContain('action suggestion_accept needs suggestionId');
  });
});
