import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import {
  closeWorld,
  type Doc,
  ok,
  type Reply,
  requester,
  startQueue,
  testEnv,
} from '../helpers/ecosystem-world.js';
import { addProjectMember, createTestProject, createTestUser, rows } from '../helpers/factories.js';
import { seedProjectDocument } from '../helpers/release-world.js';

// The issue a design revision is drawn under (ISS-261), what its approval records on that issue
// (ISS-262), and how long a decision's reason may be (ISS-263).

let ownerId: string;
let gitProject: string;
let outsideProject: string;
let say: (who: 'owner' | 'master', method: string, path: string, body?: unknown) => Promise<Reply>;
let designLandingOf: typeof import('../../src/issues/design-landing.js').designLandingOf;
let mergeNotRecorded: typeof import('../../src/issues/merged-at.js').mergeNotRecorded;

const design = (): Doc =>
  JSON.parse(
    readFileSync(
      new URL('../fixtures/workflows/post-discharge.design.json', import.meta.url),
      'utf8',
    ),
  );

beforeAll(async () => {
  testEnv();
  const { app } = await import('../../src/index.js');
  await startQueue();
  const { signUserToken } = await import('../../src/credentials/jwt.js');
  const { mintPat } = await import('../../src/credentials/pat.js');
  ({ designLandingOf } = await import('../../src/issues/design-landing.js'));
  ({ mergeNotRecorded } = await import('../../src/issues/merged-at.js'));
  ownerId = (await createTestUser({ verified: true })).id;
  gitProject = (await createTestProject(ownerId)).id;
  outsideProject = (await createTestProject(ownerId)).id;
  await seedProjectDocument(gitProject, ownerId, { environments: {} });
  await seedProjectDocument(outsideProject, ownerId, {
    environments: {},
    source: { type: 'none' },
  });
  const agent = (await createTestUser({ kind: 'agent' })).id;
  await addProjectMember(gitProject, agent, 'member');
  await addProjectMember(outsideProject, agent, 'member');
  say = requester(app, {
    owner: await signUserToken(ownerId),
    master: (
      await mintPat({ userId: agent, name: 'master', projectIds: [gitProject, outsideProject] })
    ).plaintext,
  });
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

const at = (project: string, path: string) => `/api/projects/${project}${path}`;
const codesOf = (r: Reply) => (r.json.error?.refusals ?? []).map((x: Doc) => x.code);

interface Mark {
  mergedAt?: Date | null;
  sha?: string | null;
  landing?: string | null;
}

let seq = 500;
/** An issue planted at a status and mark under the kernel's flag: the subject is what a design write or decision does to it. */
async function plantIssue(project: string, status: string, mark: Mark = {}) {
  const id = randomUUID();
  seq += 1;
  const { withKernelMarker } = await import('../../src/db/kernel-marker.js');
  await withKernelMarker(db, (tx) =>
    tx.execute(sql`
      INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id,
                          merged_at, merged_commit_sha, merged_landing)
      VALUES (${id}, ${project}, ${seq}, ${`planted ${status}`}, ${status}, ${ownerId},
              ${mark.mergedAt?.toISOString() ?? null}::timestamptz, ${mark.sha ?? null},
              ${mark.landing ?? null})
    `),
  );
  return { id, key: `ISS-${seq}` };
}

async function markOf(issueId: string) {
  const [row] = await rows<{
    status: string;
    merged_at: string | null;
    merged_commit_sha: string | null;
    merged_landing: string | null;
  }>(
    sql`SELECT status, merged_at, merged_commit_sha, merged_landing FROM issues WHERE id = ${issueId}`,
  );
  return row && { ...row, merged_at: row.merged_at === null ? null : new Date(row.merged_at) };
}

async function proposedDesign(project: string, flow: string, issue?: string): Promise<string> {
  const d = design();
  d.project = project;
  d.flow = flow;
  const made = ok(
    await say('master', 'POST', at(project, '/workflows'), { baseRevision: null, document: d }),
    201,
  );
  const id = made.document.id as string;
  ok(
    await say('master', 'POST', at(project, `/workflows/${id}/design/propose`), {
      revision: 1,
      ...(issue ? { issue } : {}),
    }),
  );
  return id;
}

/** A PUT that changes the design, so it proposes a new revision; `issue` names the drawing issue. */
async function writeChanged(project: string, id: string, issue?: string): Promise<Reply> {
  const read = ok(await say('master', 'GET', at(project, `/workflows/${id}`)));
  const document = { ...read.document, summary: `${read.document.summary} (rev ${read.revision})` };
  return say('master', 'PUT', at(project, `/workflows/${id}`), {
    baseRevision: read.revision,
    document,
    ...(issue ? { issue } : {}),
  });
}

const decide = (project: string, id: string, revision: number, decision: string, reason?: string) =>
  say('owner', 'POST', at(project, `/workflows/${id}/design/decision`), {
    revision,
    decision,
    ...(reason === undefined ? {} : { reason }),
  });

const designOf = async (project: string, id: string) =>
  ok(await say('master', 'GET', at(project, `/workflows/${id}/design`)));

describe('a write proposing a revision names the issue drawing it (ISS-261)', () => {
  for (const status of ['closed', 'dropped'] as const) {
    it(`refuses a write naming no issue where the superseded revision's issue is ${status}, and writes nothing`, async () => {
      const lapsed = await plantIssue(
        gitProject,
        status,
        status === 'closed' ? { mergedAt: new Date() } : {},
      );
      const id = await proposedDesign(gitProject, `lapsed-${status}-flow`, lapsed.id);
      ok(await decide(gitProject, id, 1, 'approve'));
      const before = await designOf(gitProject, id);

      const res = await writeChanged(gitProject, id);
      expect(res.status, JSON.stringify(res.json)).toBe(422);
      expect(codesOf(res)).toEqual(['WORKFLOW_DESIGN_ISSUE_REQUIRED']);
      const [refusal] = res.json.error.refusals;
      expect(refusal.path).toBe('/issue');
      expect(refusal.detail).toContain(
        `revision 1, the one it supersedes, was drawn under ${lapsed.key}, which is ${status}`,
      );
      expect(refusal.detail).toContain(`workflow lapsed-${status}-flow's design`);
      expect(refusal.detail).not.toContain(id);

      const after = await designOf(gitProject, id);
      expect(after.revision).toBe(before.revision);
      expect(after.status).toBe('approved');
      expect(after.revisions).toHaveLength(1);
    });
  }

  it('draws the revision under the issue the write names, and a return goes to that issue', async () => {
    const closed = await plantIssue(gitProject, 'closed', { mergedAt: new Date() });
    const id = await proposedDesign(gitProject, 'renamed-flow', closed.id);
    ok(await decide(gitProject, id, 1, 'approve'));
    const drawing = await plantIssue(gitProject, 'open');

    ok(await writeChanged(gitProject, id, drawing.key));
    const proposed = await designOf(gitProject, id);
    expect(proposed.revisions[0]).toMatchObject({ revision: 2, designIssueId: drawing.id });

    const returned = ok(await decide(gitProject, id, 2, 'return', 'name the consent owner'));
    expect(returned.designIssue).toMatchObject({ issueId: drawing.id, action: 'commented' });
    expect((await markOf(closed.id))?.status).toBe('closed');
    const onClosed = await rows<{ body: string }>(
      sql`SELECT body FROM comments WHERE issue_id = ${closed.id}`,
    );
    expect(onClosed.map((c) => c.body).join('\n')).not.toContain('name the consent owner');
  });

  it('inherits the superseded revision issue while it is still work', async () => {
    const live = await plantIssue(gitProject, 'awaiting_release', { mergedAt: new Date() });
    const id = await proposedDesign(gitProject, 'inherited-flow', live.id);
    ok(await decide(gitProject, id, 1, 'approve'));
    ok(await writeChanged(gitProject, id));
    expect((await designOf(gitProject, id)).revisions[0]).toMatchObject({
      revision: 2,
      designIssueId: live.id,
    });
  });

  /** FB-54's patient-data-flow rev 8: a revision the old code stored with no issue after its issue closed. */
  async function storedWithNone(id: string, revision: number) {
    await db.execute(sql`
      UPDATE project_workflow_designs SET design_issue_id = NULL
       WHERE workflow_id = ${id} AND revision = ${revision}
    `);
  }

  it('refuses a write naming no issue past a revision stored with none, where an earlier revision named an issue now closed', async () => {
    const closed = await plantIssue(gitProject, 'closed', { mergedAt: new Date() });
    const id = await proposedDesign(gitProject, 'null-after-closed-flow', closed.id);
    ok(await decide(gitProject, id, 1, 'approve'));
    ok(await writeChanged(gitProject, id, (await plantIssue(gitProject, 'open')).key));
    await storedWithNone(id, 2);
    ok(await decide(gitProject, id, 2, 'approve'));
    const before = await designOf(gitProject, id);

    const res = await writeChanged(gitProject, id);
    expect(res.status, JSON.stringify(res.json)).toBe(422);
    expect(codesOf(res)).toEqual(['WORKFLOW_DESIGN_ISSUE_REQUIRED']);
    const [refusal] = res.json.error.refusals;
    expect(refusal.path).toBe('/issue');
    expect(refusal.detail).toContain(
      `revision 2, the one it supersedes, names no issue, and revision 1, the latest that named one, was drawn under ${closed.key}, which is closed`,
    );
    expect(refusal.detail).not.toContain('the one it supersedes, was drawn under');
    expect(refusal.detail).toContain("workflow null-after-closed-flow's design");
    const after = await designOf(gitProject, id);
    expect(after.revision).toBe(before.revision);
    expect(after.revisions).toHaveLength(2);
  });

  it('inherits the issue an earlier revision named past a revision stored with none, while that issue is still work', async () => {
    const live = await plantIssue(gitProject, 'in_progress');
    const id = await proposedDesign(gitProject, 'null-after-live-flow', live.id);
    ok(await decide(gitProject, id, 1, 'approve'));
    ok(await writeChanged(gitProject, id));
    await storedWithNone(id, 2);
    ok(await decide(gitProject, id, 2, 'approve'));

    ok(await writeChanged(gitProject, id));
    expect((await designOf(gitProject, id)).revisions[0]).toMatchObject({
      revision: 3,
      designIssueId: live.id,
    });
  });

  it('proposes with no issue where no revision ever named one', async () => {
    const id = await proposedDesign(gitProject, 'never-named-flow');
    ok(await decide(gitProject, id, 1, 'approve'));
    ok(await writeChanged(gitProject, id));
    expect((await designOf(gitProject, id)).revisions[0]).toMatchObject({
      revision: 2,
      designIssueId: null,
    });
  });
});

describe('an approval records the approved revision on the issue that drew it (ISS-262)', () => {
  it('marks an unmarked design issue with the approved revision as its landing, moving no status', async () => {
    const issue = await plantIssue(outsideProject, 'in_progress');
    expect(
      await mergeNotRecorded(db, { issueId: issue.id, to: 'awaiting_release' }),
    ).not.toBeNull();
    const id = await proposedDesign(outsideProject, 'marked-flow', issue.id);

    const approved = ok(await decide(outsideProject, id, 1, 'approve'));
    expect(approved.designIssue).toMatchObject({
      issueId: issue.id,
      action: 'marked',
      mark: 'landed',
      status: 'in_progress',
    });
    const row = await markOf(issue.id);
    expect(row?.status).toBe('in_progress');
    expect(row?.merged_at).not.toBeNull();
    expect(row?.merged_landing).toBe(designLandingOf('marked-flow', 1));
    expect(await mergeNotRecorded(db, { issueId: issue.id, to: 'awaiting_release' })).toBeNull();
  });

  it('re-points a landing written at propose to the revision approved, and says what it replaced', async () => {
    const proposedLanding = 'workflow repointed-flow rev 1, proposed';
    const issue = await plantIssue(outsideProject, 'awaiting_release', {
      mergedAt: new Date('2026-10-01T10:00:00Z'),
      landing: proposedLanding,
    });
    const id = await proposedDesign(outsideProject, 'repointed-flow', issue.id);
    ok(await writeChanged(outsideProject, id));

    const approved = ok(await decide(outsideProject, id, 2, 'approve'));
    expect(approved.designIssue).toMatchObject({
      issueId: issue.id,
      action: 'repointed',
      mark: 'landed',
      status: 'awaiting_release',
    });
    const row = await markOf(issue.id);
    expect(row?.status).toBe('awaiting_release');
    expect(row?.merged_landing).toBe(designLandingOf('repointed-flow', 2));
    expect(row?.merged_at?.getTime()).toBeGreaterThan(new Date('2026-10-01T10:00:00Z').getTime());
    const posted = await rows<{ body: string }>(
      sql`SELECT body FROM comments WHERE issue_id = ${issue.id}`,
    );
    const notice = posted.map((c) => c.body).find((b) => b.includes('was approved'));
    expect(notice).toContain('revision 2');
    expect(notice).toContain(proposedLanding);
  });

  it('keeps a merge Forge observed', async () => {
    const at = new Date('2026-10-01T10:00:00Z');
    const sha = 'a'.repeat(40);
    const issue = await plantIssue(outsideProject, 'in_progress', { mergedAt: at, sha });
    const id = await proposedDesign(outsideProject, 'observed-flow', issue.id);
    const approved = ok(await decide(outsideProject, id, 1, 'approve'));
    expect(approved.designIssue).toMatchObject({ action: 'kept', mark: 'observed' });
    const row = await markOf(issue.id);
    expect(row?.merged_commit_sha).toBe(sha);
    expect(row?.merged_landing).toBeNull();
    expect(row?.merged_at?.getTime()).toBe(at.getTime());
  });

  it('on a git project, stamps an unmarked design issue and keeps a standing mark', async () => {
    const unmarked = await plantIssue(gitProject, 'in_progress');
    const first = await proposedDesign(gitProject, 'git-marked-flow', unmarked.id);
    expect(ok(await decide(gitProject, first, 1, 'approve')).designIssue).toMatchObject({
      action: 'marked',
      mark: 'asserted',
    });
    const stamped = await markOf(unmarked.id);
    expect(stamped?.merged_at).not.toBeNull();
    expect(stamped?.merged_landing).toBeNull();

    const at = new Date('2026-10-01T10:00:00Z');
    const marked = await plantIssue(gitProject, 'awaiting_release', { mergedAt: at });
    const second = await proposedDesign(gitProject, 'git-kept-flow', marked.id);
    expect(ok(await decide(gitProject, second, 1, 'approve')).designIssue).toMatchObject({
      action: 'kept',
      mark: 'asserted',
      status: 'awaiting_release',
    });
    expect((await markOf(marked.id))?.merged_at?.getTime()).toBe(at.getTime());
  });

  it('writes no mark on a return, nor on a dropped design issue', async () => {
    const returnedIssue = await plantIssue(outsideProject, 'in_progress');
    const returned = await proposedDesign(
      outsideProject,
      'returned-unmarked-flow',
      returnedIssue.id,
    );
    ok(await decide(outsideProject, returned, 1, 'return', 'draw the consent check'));
    expect((await markOf(returnedIssue.id))?.merged_at).toBeNull();

    const dropped = await plantIssue(outsideProject, 'dropped');
    const id = await proposedDesign(outsideProject, 'dropped-flow', dropped.id);
    const approved = ok(await decide(outsideProject, id, 1, 'approve'));
    expect(approved.designIssue).toMatchObject({ issueId: dropped.id, action: 'none' });
    expect(approved.designIssue.why).toContain('dropped');
    const row = await markOf(dropped.id);
    expect(row?.status).toBe('dropped');
    expect(row?.merged_at).toBeNull();
  });
});

describe('an approval leaves the mark of a design issue that already shipped (ISS-262)', () => {
  it('writes no mark on a closed design issue, and its notice says the approval came after the close', async () => {
    const shippedAt = new Date('2026-10-01T10:00:00Z');
    const shippedLanding = 'workflow closed-flow rev 1, proposed';
    const issue = await plantIssue(outsideProject, 'closed', {
      mergedAt: shippedAt,
      landing: shippedLanding,
    });
    const id = await proposedDesign(outsideProject, 'closed-flow', issue.id);

    const approved = ok(await decide(outsideProject, id, 1, 'approve'));
    expect(approved.designIssue).toMatchObject({
      issueId: issue.id,
      action: 'none',
      status: 'closed',
      mark: 'landed',
    });
    expect(approved.designIssue.why).toContain('closed');
    const row = await markOf(issue.id);
    expect(row?.status).toBe('closed');
    expect(row?.merged_at?.getTime()).toBe(shippedAt.getTime());
    expect(row?.merged_commit_sha).toBeNull();
    expect(row?.merged_landing).toBe(shippedLanding);
    const posted = await rows<{ body: string }>(
      sql`SELECT body FROM comments WHERE issue_id = ${issue.id}`,
    );
    const notice = posted.map((c) => c.body).find((b) => b.includes('was approved'));
    expect(notice).toContain('after this issue was closed');
    expect(notice).not.toContain('takes its next move');
    expect(notice).toContain('To change this design again, name the issue drawing the change');
  });
});

describe("a decision's reason holds what a decision comment holds (ISS-263)", () => {
  it('takes a 4000-character return reason whole', async () => {
    const id = await proposedDesign(gitProject, 'long-reason-flow');
    const reason = 'r'.repeat(4000);
    ok(await decide(gitProject, id, 1, 'return', reason));
    expect((await designOf(gitProject, id)).revisions[0].reason).toBe(reason);
  });

  it('refuses a 4001-character reason by its shape, and decides nothing', async () => {
    const id = await proposedDesign(gitProject, 'too-long-reason-flow');
    const res = await decide(gitProject, id, 1, 'return', 'r'.repeat(4001));
    expect(res.status, JSON.stringify(res.json).slice(0, 400)).toBe(400);
    expect(JSON.stringify(res.json)).toContain('a return carries its reason');
    expect((await designOf(gitProject, id)).status).toBe('proposed');
  });
});
