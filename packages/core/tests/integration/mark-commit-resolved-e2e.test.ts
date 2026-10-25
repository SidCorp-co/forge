/**
 * ISS-1350 — on a git project every commit a merge mark records is one the project's repository
 * holds, resolved there to its full sha, whoever marks it and whatever evidence the issue carries;
 * against a real Postgres and the repository stand-in in `tests/helpers/commit-landing-fixture.ts`.
 */

import { sql } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';

process.env.JWT_SECRET ??= 'integration-test-secret-padded-to-32-chars-long';
process.env.DEVICE_TOKEN_PEPPER ??= 'integration-test-pepper-padded-to-32-chars-long';

import {
  FABRICATED,
  OWN,
  refusal,
  repo,
  useCommitLandingWorld,
} from '../helpers/commit-landing-fixture.js';

vi.mock('../../src/issues/merge-record.js', async (importOriginal) =>
  (await import('../helpers/commit-landing-fixture.js')).fakeMergeRecord(await importOriginal()),
);
vi.mock('../../src/integrations/github/client.js', async (importOriginal) =>
  (await import('../helpers/commit-landing-fixture.js')).fakeGitHubClient(await importOriginal()),
);

const { seed, mark, row, comments, handoff, current } = useCommitLandingWorld();

/** sid-desk ISS-578's mark: a real commit's first eight characters, then a tail no commit has. */
const ISS_578_PAIR = `${OWN.slice(0, 8)}0e1cf5dadf2b1b3be9ba1b81c5e9cb40`;

describe("ISS-1350 — every git mark's commit is one the repository holds (real Postgres)", () => {
  it.each([
    ['a person, on an issue with no branch', 'human', {}],
    ['a person, on an issue with a branch', 'human', { branch: 'ISS-1350-x' }],
    ['an agent, on an issue with a branch', 'agent', { branch: 'ISS-1350-x' }],
  ] as const)(
    'refuses the ISS-578 pair marked by %s, naming it and the repository, and writes nothing (criteria 1, 2)',
    async (_who, agency, sessionContext) => {
      const issue = await seed({ sessionContext });
      const refused = await refusal(() => mark(issue, ISS_578_PAIR, agency));
      expect(refused.code).toBe('COMMIT_NOT_IN_REPOSITORY');
      expect(refused.message).toContain(
        `The repository ${repo.fullName} holds no commit ${ISS_578_PAIR.slice(0, 7)}.`,
      );
      expect(await row(issue.id)).toMatchObject({ merged_at: null, merged_commit_sha: null });
      expect(await comments(issue.id)).toEqual([]);
    },
  );

  it('refuses a commit the repository lacks beside a merged pull request, rather than keeping it as an overruled claim (criterion 3)', async () => {
    repo.pullRequest = {
      commitSha: '0123456789abcdef0123456789abcdef01234567',
      mergedAt: new Date('2026-09-30T08:00:00Z'),
    };
    const issue = await seed({ sessionContext: { branch: 'ISS-1350-x' } });
    const refused = await refusal(() => mark(issue, FABRICATED, 'human'));
    expect(refused.code).toBe('COMMIT_NOT_IN_REPOSITORY');
    expect(await row(issue.id)).toMatchObject({ merged_at: null, merged_commit_sha: null });
  });

  it('does not re-read a commit that is the merged pull request it stands beside', async () => {
    const pr = '0123456789abcdef0123456789abcdef01234567';
    repo.pullRequest = { commitSha: pr, mergedAt: new Date('2026-09-30T08:00:00Z') };
    const issue = await seed({ sessionContext: { branch: 'ISS-1350-x' } });
    const res = await mark(issue, pr.toUpperCase(), 'human');
    expect(res.mark).toBe('observed');
    expect(repo.reads).toEqual([]);
  });

  it.each([
    ['no_binding', 'names no repository URL, so there is no repository to read'],
    ['read', 'HTTP 502'],
    ['mint', 'Minting an installation token: HTTP 404.'],
  ] as const)(
    "refuses a person's mark COMMIT_UNVERIFIED when the repository cannot be read (%s) (criterion 4)",
    async (down, says) => {
      repo.down = down;
      const issue = await seed({ sessionContext: { branch: 'ISS-1350-x' } });
      const refused = await refusal(() => mark(issue, OWN, 'human'));
      expect(refused.code).toBe('COMMIT_UNVERIFIED');
      expect(refused.message).toContain(says);
      expect(
        refused.message.startsWith(
          `Nothing was marked, because Forge could not check commit ${OWN.slice(0, 7)} against the repository.`,
        ),
      ).toBe(true);
      // ISS-1421 r8, criterion 124: offered only here, on an issue not yet marked.
      expect(refused.message).toContain('Or mark it naming no commit, which records a claim.');
      expect(await row(issue.id)).toMatchObject({ merged_at: null, merged_commit_sha: null });
    },
  );

  it('records an abbreviated commit by the full sha the repository resolves, in the answer and the audit comment (criterion 5)', async () => {
    const issue = await seed({ sessionContext: { branch: 'ISS-1350-x' } });
    const short = OWN.slice(0, 9);
    const res = await mark(issue, short, 'human');
    // ISS-1421 — a person reads seven characters of the resolved commit; the row keeps all forty.
    expect(res.markDetail).toContain(
      `Commit ${OWN.slice(0, 7)} is in ${repo.fullName}, and is recorded as where this work landed.`,
    );
    expect((await row(issue.id)).merged_commit_sha).toBe(OWN);
    const audit = (await comments(issue.id)).at(-1) ?? '';
    expect(audit).toBe(`Marked merged into main.\n${res.markDetail}`);
    expect(audit).not.toMatch(/\b[0-9a-f]{40}\b/);
    // ISS-1421 r4 — a person reads this thread: no action or field name an agent sends.
    expect(audit).not.toMatch(/mark_merged|\b(target|commit)=|`(un)?mark`/);
    expect(audit).not.toContain(`at commit ${short}.`);
  });

  // ISS-1300 r3 — the ruling that a person's mark carries the commit that landed replaced r8's
  // "noted in the comment only": the row keeps it, flagged as their word, and the mark stays a claim.
  it("records a person's resolved commit as the landing, as their claim, and says the repository holds it (criteria 6, 7)", async () => {
    const issue = await seed({ sessionContext: {} });
    const res = await mark(issue, OWN, 'human');
    expect(res.mark).toBe('asserted');
    expect(await row(issue.id)).toMatchObject({
      merged_commit_sha: OWN,
      merged_claimed_commit: null,
    });
    expect(res.markDetail).toBe(
      `Commit ${OWN.slice(0, 7)} is in ${repo.fullName}, and is recorded as where this work landed. Forge did not see this merge, so the mark is a claim.`,
    );
  });

  // ISS-1300 r3 review F1 — an agent's mark that reads the very commit a person stated as this
  // issue's landing turns the claim into Forge's own record, and it counts as work evidence then.
  it("turns a person's stated commit into an observed mark once an agent's mark reads it as the landing", async () => {
    const issue = await seed({ sessionContext: {} });
    await mark(issue, OWN, 'human');
    const { db } = current();
    const stated = await db.execute<{ merged_commit_stated: boolean }>(
      sql`SELECT merged_commit_stated FROM issues WHERE id = ${issue.id}`,
    );
    expect(stated[0]?.merged_commit_stated).toBe(true);

    const res = await mark({ ...issue, mergedAt: new Date() }, OWN, 'agent');

    expect(res.mark).toBe('observed');
    const after = await db.execute<{ merged_commit_stated: boolean; merged_commit_sha: string }>(
      sql`SELECT merged_commit_stated, merged_commit_sha FROM issues WHERE id = ${issue.id}`,
    );
    expect(after[0]).toMatchObject({ merged_commit_stated: false, merged_commit_sha: OWN });
  });

  it('turns it observed though a merged pull request names another commit the repository lacks', async () => {
    const issue = await seed({ sessionContext: {} });
    const ABSENT_PR = 'f'.repeat(40);
    repo.pullRequest = { commitSha: ABSENT_PR, mergedAt: new Date('2026-10-01T09:00:00Z') };
    await mark(issue, OWN, 'human');
    expect((await row(issue.id)).merged_commit_sha).toBe(OWN);

    const res = await mark({ ...issue, mergedAt: new Date() }, OWN, 'agent');

    expect(res.mark).toBe('observed');
    expect((await row(issue.id)).merged_commit_sha).toBe(OWN);
  });

  // ISS-1300 r3 review F2 — a stored abbreviation the repository cannot resolve is replaced by the
  // full commit a person names, though that commit begins with it.
  it('replaces a stored abbreviation the repository cannot resolve with the full commit a person names', async () => {
    const issue = await seed({ sessionContext: {} });
    const { db } = current();
    await db.execute(
      sql`UPDATE issues SET merged_at = now(), merged_commit_sha = ${OWN.slice(0, 7)} WHERE id = ${issue.id}`,
    );

    const res = await mark({ ...issue, mergedAt: new Date() }, OWN, 'human');

    expect(res.action).toBe('merged');
    expect((await row(issue.id)).merged_commit_sha).toBe(OWN);
  });

  it('records no commit from a handoff on a mark naming none, even one the repository holds (ISS-1133 criterion 5)', async () => {
    const issue = await seed({ sessionContext: { branch: 'ISS-1350-x' } });
    await handoff(issue.id, OWN.slice(0, 10));
    const res = await mark(issue, undefined, 'human');
    expect(res.mark).toBe('asserted');
    expect((await row(issue.id)).merged_commit_sha).toBeNull();
    expect(res.markDetail).toContain('No commit was named.');
    expect(res.markDetail).not.toContain(OWN.slice(0, 10));
    expect(repo.reads).toEqual([]);
    expect((await comments(issue.id)).at(-1)).not.toMatch(/^Marked merged[^\n]*at commit/);
  });

  it('names no handoff commit on a mark that repeats one Forge observed (ISS-1133 criterion 5)', async () => {
    const issue = await seed();
    expect((await mark(issue, OWN)).mark).toBe('observed');
    await handoff(issue.id, FABRICATED);
    const res = await mark(issue, undefined, 'human');
    expect(res.action).toBe('already_merged');
    expect(res.mark).toBe('observed');
    expect(res.markDetail).not.toContain(FABRICATED);
    expect((await comments(issue.id)).at(-1)).not.toContain(FABRICATED);
  });

  it('reads nothing from the repository on an outside_git project (criterion 10)', async () => {
    const issue = await seed({ kind: 'website', sessionContext: { branch: 'ISS-1350-x' } });
    await mark(issue, ISS_578_PAIR, 'human', { landing: 'https://shop.example/p/1350' });
    expect(repo.reads).toEqual([]);
  });
});
