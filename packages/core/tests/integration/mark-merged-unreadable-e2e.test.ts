/**
 * ISS-1421 r43 (judge-171 on 407) — on a project naming a repository Forge cannot read, the close
 * refusal and the missing merge-mark record told the reader to name the commit under Commit, and
 * doing exactly that was refused COMMIT_UNVERIFIED while Mark merged's own panel there said to leave
 * Commit empty. Every sentence asking for Mark merged now says what that project's Mark merged
 * takes, and its step is followed here to a mark that succeeds. Real Postgres; no repository reader
 * is mocked, because none is declared: the project names a repository and holds no way to read it.
 */

import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

process.env.JWT_SECRET ??= 'integration-test-secret-padded-to-32-chars-long';
process.env.DEVICE_TOKEN_PEPPER ??= 'integration-test-pepper-padded-to-32-chars-long';

import { refusal, useCommitLandingWorld } from '../helpers/commit-landing-fixture.js';

const { seed, mark, row, current } = useCommitLandingWorld();

const UNREADABLE = 'git@git.example.invalid:qa/unreadable.git';
const LEAVE_EMPTY = 'Leave Commit empty to record a claim naming no commit';
const ASK_COMMIT = 'name the commit that landed under Commit';

/** The project names a repository Forge holds no GitHub connection and no deploy key for. */
async function nameUnreadableRepository(): Promise<void> {
  const { db, projectId } = current();
  await db.execute(sql`UPDATE projects SET repo_url = ${UNREADABLE} WHERE id = ${projectId}`);
}

async function declareMarkOnEntry(): Promise<void> {
  const { db, projectId } = current();
  await db.execute(sql`
    UPDATE projects SET agent_config = ${JSON.stringify({
      pipelineConfig: { statusEntryCriteria: { awaiting_release: ['merged_mark'] } },
    })}::jsonb WHERE id = ${projectId}
  `);
}

async function moveTo(issue: { id: string; projectId: string }, to: 'closed' | 'awaiting_release') {
  const { transitionIssueStatus } = await import('../../src/issues/apply-transition.js');
  const { userId } = current();
  const [now] = await current().db.execute<{ status: string; reopen_count: number }>(
    sql`SELECT status, reopen_count FROM issues WHERE id = ${issue.id}`,
  );
  return transitionIssueStatus(
    {
      id: issue.id,
      projectId: issue.projectId,
      status: now?.status as never,
      reopenCount: Number(now?.reopen_count ?? 0),
    },
    to,
    { type: 'user', id: userId, agency: 'human' },
  );
}

describe('Mark merged on a project whose repository Forge cannot read (ISS-1421 r43)', () => {
  it('reads as refused: a repository named, and no way to read it', async () => {
    await nameUnreadableRepository();
    const { markCommitCheck } = await import('../../src/projects/live-source.js');
    expect(await markCommitCheck(current().projectId)).toBe('refused');
  });

  it('tells the close refusal to leave Commit empty, and never to name the commit', async () => {
    await nameUnreadableRepository();
    const issue = await seed({ status: 'awaiting_release' });
    const refused = await refusal(() => moveTo(issue, 'closed'));
    expect(refused.code).toBe('CLOSE_REQUIRES_SHIPPED');
    expect(refused.message).toContain(`fill in Where it landed. ${LEAVE_EMPTY}.`);
    expect(refused.message).not.toContain(ASK_COMMIT);
  });

  it('tells the missing merge-mark record to leave Commit empty, and never to name the commit', async () => {
    await nameUnreadableRepository();
    await declareMarkOnEntry();
    const issue = await seed({ status: 'tested' });
    const refused = await refusal(() => moveTo(issue, 'awaiting_release'));
    expect(refused.code).toBe('ENTRY_CRITERIA_UNMET');
    expect(refused.message).toContain(LEAVE_EMPTY);
    expect(refused.message).not.toContain(ASK_COMMIT);
  });

  it("tells the release gate's row to leave Commit empty", async () => {
    await nameUnreadableRepository();
    const issue = await seed({ status: 'awaiting_release' });
    const { rosterCloseShortfalls } = await import('../../src/release-batch/close-shortfall.js');
    const [found] = (await rosterCloseShortfalls(issue.projectId, [issue.id])).get(issue.id) ?? [];
    expect(found?.code).toBe('CLOSE_REQUIRES_SHIPPED');
    expect(found?.clears).toContain(LEAVE_EMPTY);
    expect(found?.clearsHere).toContain(LEAVE_EMPTY);
    expect(found?.clears).not.toContain(ASK_COMMIT);
  });

  // The old step, planted: naming the commit is refused there, which is why no sentence asks for it.
  it('refuses a person naming a commit there, and marks nothing', async () => {
    await nameUnreadableRepository();
    const issue = await seed({ status: 'awaiting_release' });
    const refused = await refusal(() => mark(issue, 'a'.repeat(40), 'human'));
    expect(refused.code).toBe('COMMIT_UNVERIFIED');
    expect((await row(issue.id)).merged_at).toBeNull();
  });

  it('marks the issue merged when the step is followed: Where it landed filled in, Commit empty', async () => {
    await nameUnreadableRepository();
    const issue = await seed({ status: 'awaiting_release' });
    const res = await mark(issue, undefined, 'human', { target: 'main' });
    expect(res.action).toBe('merged');
    expect((await row(issue.id)).merged_at).not.toBeNull();
    // The close no longer stops on the mark.
    const { refuseUnshippedClose } = await import('../../src/issues/merged-at.js');
    expect(
      await refuseUnshippedClose(current().db, { issueId: issue.id, toStatus: 'closed' }),
    ).toBeNull();
  });
});
