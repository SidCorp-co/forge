import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import {
  codesOf,
  decide,
  designIssueWorld,
  designLandingOf,
  designOf,
  gitProject,
  markOf,
  mergeNotRecorded,
  outsideProject,
  plantIssue,
  proposedDesign,
  writeChanged,
} from '../helpers/design-issue-world.js';
import { ok } from '../helpers/ecosystem-world.js';
import { rows } from '../helpers/factories.js';

// The issue a design revision is drawn under (ISS-261), and what its approval records on that issue
// (ISS-262). An approval on an issue that shipped or is linked as a build, and how long a decision's
// reason may be (ISS-263): `design-approval-after-e2e`.

designIssueWorld();

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
        `Revision 1, the one it supersedes, was drawn under ${lapsed.key}, which is ${status}.`,
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
      `Revision 2, the one it supersedes, names no issue. Revision 1 is the latest that named one, and it was drawn under ${closed.key}, which is closed.`,
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
    expect(row?.merged_artifacts).toEqual([
      { surface: 'design', ref: 'marked-flow@rev1', change: 'changed' },
    ]);
    // the landing is the design's, so it closes through design_delivered and never waits at
    // awaiting_release for a release no roster gives it: refused there by name, outside git too
    expect(await mergeNotRecorded(db, { issueId: issue.id, to: 'awaiting_release' })).toMatchObject(
      {
        code: 'MERGE_DESIGN_ONLY',
        details: { mark: 'design_only', designs: ['marked-flow@rev1'], useInstead: 'closed' },
      },
    );
    expect(await mergeNotRecorded(db, { issueId: issue.id, to: 'closed' })).toBeNull();
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

  it('keeps a landing that names code outside git, so the issue stays a code carrier the release takes', async () => {
    const landing = 'hop storefront: the checkout page, live';
    const issue = await plantIssue(outsideProject, 'in_progress', {
      mergedAt: new Date('2026-10-01T10:00:00Z'),
      landing,
    });
    await db.execute(
      sql`UPDATE issues SET merged_artifacts = ${JSON.stringify([{ surface: 'ui', ref: 'checkout', change: 'changed' }])}::jsonb WHERE id = ${issue.id}`,
    );
    const id = await proposedDesign(outsideProject, 'kept-code-flow', issue.id);

    const approved = ok(await decide(outsideProject, id, 1, 'approve'));
    expect(approved.designIssue).toMatchObject({ issueId: issue.id, action: 'kept' });
    const row = await markOf(issue.id);
    expect(row?.merged_landing).toBe(landing);
    expect(row?.merged_artifacts).toEqual([{ surface: 'ui', ref: 'checkout', change: 'changed' }]);
    expect(await mergeNotRecorded(db, { issueId: issue.id, to: 'awaiting_release' })).toBeNull();
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
    expect(stamped?.merged_artifacts).toEqual([
      { surface: 'design', ref: 'git-marked-flow@rev1', change: 'changed' },
    ]);

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
