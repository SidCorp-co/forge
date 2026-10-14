import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import {
  at,
  decide,
  designIssueWorld,
  designOf,
  gitProject,
  type Mark,
  markOf,
  mergeNotRecorded,
  outsideProject,
  plantIssue,
  proposedDesign,
  say,
} from '../helpers/design-issue-world.js';
import { ok } from '../helpers/ecosystem-world.js';
import { rows } from '../helpers/factories.js';

// What a design approval leaves standing on an issue that already shipped or is linked as a build
// (ISS-262), and how long a decision's reason may be (ISS-263). Where the approval records the
// revision on the issue drawing it: `design-issue-e2e`.

designIssueWorld();

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

describe('an approval is evidence, never the landing, on an issue linked as a build', () => {
  /** An issue linked as the build of `built`, a workflow other than the one drawn under it. */
  async function buildIssue(project: string, built: string, mark: Mark = {}) {
    const issue = await plantIssue(project, 'open', mark);
    const builtId = await proposedDesign(project, built);
    ok(
      await say('master', 'POST', at(project, `/workflows/${builtId}/builds`), {
        issue: issue.key,
      }),
    );
    return issue;
  }

  const noticesOn = async (issueId: string) =>
    (await rows<{ body: string }>(sql`SELECT body FROM comments WHERE issue_id = ${issueId}`)).map(
      (c) => c.body,
    );

  for (const shape of ['outside_git', 'git'] as const) {
    it(`writes no mark on a ${shape} build issue and records the approved revision on it as evidence`, async () => {
      const project = shape === 'git' ? gitProject : outsideProject;
      const flow = shape.replace('_', '-');
      const issue = await buildIssue(project, `${flow}-tour-flow`);
      const id = await proposedDesign(project, `${flow}-queue-ux-flow`, issue.id);

      const approved = ok(await decide(project, id, 1, 'approve'));
      expect(approved.designIssue).toMatchObject({
        issueId: issue.id,
        action: 'evidence',
        mark: 'unmarked',
        status: 'open',
      });
      expect(approved.designIssue.why).toContain(`builds workflow ${flow}-tour-flow`);
      const row = await markOf(issue.id);
      expect(row).toMatchObject({
        status: 'open',
        merged_at: null,
        merged_landing: null,
        merged_artifacts: null,
      });
      expect(
        await mergeNotRecorded(db, { issueId: issue.id, to: 'awaiting_release' }),
      ).not.toBeNull();
      const notice = (await noticesOn(issue.id)).find((b) => b.includes('was approved'));
      expect(notice).toContain(`Design \`${flow}-queue-ux-flow\` revision 1 was approved`);
      expect(notice).toContain(`builds workflow \`${flow}-tour-flow\``);
      expect(notice).toContain('evidence for it, not its landing');
      expect(notice).not.toContain('merged mark now records it');
    });
  }

  it("leaves a build issue's own landing as it stands, and says so", async () => {
    const landing = 'hop Autoflow draft: the tour pages, built';
    const at0 = new Date('2026-10-01T10:00:00Z');
    const issue = await buildIssue(outsideProject, 'own-landing-tour-flow', {
      mergedAt: at0,
      landing,
    });
    const id = await proposedDesign(outsideProject, 'own-landing-ux-flow', issue.id);

    const approved = ok(await decide(outsideProject, id, 1, 'approve'));
    expect(approved.designIssue).toMatchObject({ action: 'evidence', mark: 'landed' });
    const row = await markOf(issue.id);
    expect(row?.merged_landing).toBe(landing);
    expect(row?.merged_at?.getTime()).toBe(at0.getTime());
    const notice = (await noticesOn(issue.id)).find((b) => b.includes('was approved'));
    expect(notice).toContain('Its merged mark is left as it stood.');
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
