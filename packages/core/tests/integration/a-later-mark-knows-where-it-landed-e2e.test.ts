/**
 * ISS-1421 r36 — judge-145 on a project naming no repository: the RELEASING refusal says to name the
 * commit that landed under Commit, and a person who did was refused 422 COMMIT_UNVERIFIED, for a
 * check no setting short of naming a repository could make. Such a mark now keeps the commit as a
 * claim nothing checked and says so. And Mark a later merge opened with Where it landed empty although
 * the mark had named it: a git mark now keeps where it said the work landed. Real Postgres, the
 * repository stood in for by `tests/helpers/commit-landing-fixture.ts`.
 */

import { sql } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';

process.env.JWT_SECRET ??= 'integration-test-secret-padded-to-32-chars-long';
process.env.DEVICE_TOKEN_PEPPER ??= 'integration-test-pepper-padded-to-32-chars-long';

import { OWN, refusal, repo, useCommitLandingWorld } from '../helpers/commit-landing-fixture.js';

vi.mock('../../src/issues/merge-record.js', async (importOriginal) =>
  (await import('../helpers/commit-landing-fixture.js')).fakeMergeRecord(await importOriginal()),
);
vi.mock('../../src/integrations/github/client.js', async (importOriginal) =>
  (await import('../helpers/commit-landing-fixture.js')).fakeGitHubClient(await importOriginal()),
);

const { seed, mark, unmark, row, comments, current } = useCommitLandingWorld();

async function markColumns(id: string) {
  const { db } = current();
  const [r] = await db.execute<{ target: string | null; claim: string | null; sha: string | null }>(
    sql`SELECT merged_target AS target, merged_claimed_commit AS claim, merged_commit_sha AS sha FROM issues WHERE id = ${id}`,
  );
  return r as { target: string | null; claim: string | null; sha: string | null };
}

async function setRepoUrl(url: string | null) {
  const { db, projectId } = current();
  await db.execute(sql`UPDATE projects SET repo_url = ${url} WHERE id = ${projectId}`);
}

describe('a person naming a commit on a project with no repository (ISS-1421 r36)', () => {
  it('keeps the commit as a claim nothing checked, and says why, instead of refusing 422', async () => {
    repo.down = 'no_binding';
    await setRepoUrl(null);
    const issue = await seed({ sessionContext: {} });
    const res = await mark(issue, OWN, 'human');
    expect(res.action).toBe('merged');
    expect(res.mark).toBe('asserted');
    expect(await markColumns(issue.id)).toMatchObject({ claim: OWN, sha: null });
    const audit = (await comments(issue.id)).at(-1) as string;
    for (const said of [res.markDetail, audit]) {
      expect(said).toContain(`Commit ${OWN.slice(0, 7)} was named and is kept as a claim.`);
      expect(said).toContain(
        "Forge has no way to read this project's repository, so it did not check it.",
      );
      expect(said).toContain('names no repository URL');
      expect(said).not.toMatch(/binding/i);
    }
  });

  it('still refuses COMMIT_UNVERIFIED where the project names a repository a key would let Forge read', async () => {
    repo.down = 'no_binding';
    await setRepoUrl('git@github.com:SidCorp-co/specimen.git');
    const issue = await seed({ sessionContext: {} });
    const refused = await refusal(() => mark(issue, OWN, 'human'));
    expect(refused.code).toBe('COMMIT_UNVERIFIED');
    expect((await row(issue.id)).merged_at).toBeNull();
  });
});

describe('where a git mark said the work landed (ISS-1421 r36)', () => {
  it('keeps the target a first mark names, and clears it with the mark', async () => {
    const issue = await seed({ sessionContext: {} });
    await mark(issue, undefined, 'human', { target: 'release/7' });
    expect((await markColumns(issue.id)).target).toBe('release/7');
    await unmark(issue, 'human');
    expect((await markColumns(issue.id)).target).toBeNull();
    await mark(issue, undefined, 'human', { target: 'main' });
    expect((await markColumns(issue.id)).target).toBe('main');
  });

  it('keeps the first target where a repeat changed nothing', async () => {
    const issue = await seed({ sessionContext: {} });
    await mark(issue, undefined, 'human', { target: 'main' });
    const repeat = await mark({ ...issue, mergedAt: new Date() }, undefined, 'human', {
      target: 'somewhere-else',
    });
    expect(repeat.action).toBe('already_merged');
    expect((await markColumns(issue.id)).target).toBe('main');
  });

  it('is served on the issue a page reads', async () => {
    const issue = await seed({ sessionContext: {} });
    await mark(issue, undefined, 'human', { target: 'main' });
    const { findIssueById } = await import('../../src/issues/read-service.js');
    expect((await findIssueById(issue.id))?.mergedTarget).toBe('main');
  });

  it('refuses a target with no mark beside it, by the column check', async () => {
    const issue = await seed({ sessionContext: {} });
    const { db } = current();
    const refused = await db
      .execute(sql`UPDATE issues SET merged_target = 'main' WHERE id = ${issue.id}`)
      .then(
        () => null,
        (err: unknown) => err as { cause?: { constraint_name?: string } },
      );
    expect(refused?.cause?.constraint_name).toBe('issues_merged_target_chk');
  });
});
