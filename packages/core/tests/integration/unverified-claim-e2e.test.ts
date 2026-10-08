/**
 * ISS-1409 — where core has no way to read a project's repository, an agent's commit mark is
 * accepted as an `asserted` mark that carries the commit as an unverified claim, and where it
 * can read, or has a reader that fails, every refusal stands. Real Postgres, the repository
 * stood in for by `tests/helpers/commit-landing-fixture.ts`.
 */

import { sql } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';

process.env.JWT_SECRET ??= 'integration-test-secret-padded-to-32-chars-long';
process.env.DEVICE_TOKEN_PEPPER ??= 'integration-test-pepper-padded-to-32-chars-long';

import {
  FABRICATED,
  FOREIGN,
  OFF_BASE,
  OWN,
  refusal,
  repo,
  UNDECLARED,
  useCommitLandingWorld,
} from '../helpers/commit-landing-fixture.js';

vi.mock('../../src/issues/merge-record.js', async (importOriginal) =>
  (await import('../helpers/commit-landing-fixture.js')).fakeMergeRecord(await importOriginal()),
);
vi.mock('../../src/integrations/github/client.js', async (importOriginal) =>
  (await import('../helpers/commit-landing-fixture.js')).fakeGitHubClient(await importOriginal()),
);

const { seed, mark, unmark, advance, row, comments, current, setBaseBranch } =
  useCommitLandingWorld();

/** `no_binding` on a project that names no repository URL: no reader is declared at all. */
const noReader = () => {
  repo.down = 'no_binding';
};

async function claimOf(id: string): Promise<string | null> {
  const { db } = current();
  const [r] = await db.execute<{ c: string | null }>(
    sql`SELECT merged_claimed_commit AS c FROM issues WHERE id = ${id}`,
  );
  return (r as { c: string | null }).c;
}

describe('ISS-1409 — no reader: the agent mark is an unverified claim (real Postgres)', () => {
  it('accepts the commit as an asserted mark and does not refuse COMMIT_UNVERIFIED (criterion 1)', async () => {
    noReader();
    const issue = await seed();
    const res = await mark(issue, OWN);
    expect(res.action).toBe('merged');
    expect(res.mark).toBe('asserted');
    expect(repo.reads).toEqual([]);
  });

  it('lets the issue advance to developed and testing on that mark (criterion 2)', async () => {
    noReader();
    const issue = await seed();
    await mark(issue, OWN);
    await advance(issue.id, 'in_progress', 'developed');
    await advance(issue.id, 'developed', 'testing');
    expect((await row(issue.id)).status).toBe('testing');
  });

  it('says in the answer and the audit comment that the commit is not verified, and names the setting once (criterion 3)', async () => {
    noReader();
    const issue = await seed();
    const res = await mark(issue, OWN);
    const audit = (await comments(issue.id)).at(-1) as string;
    for (const text of [res.markDetail, audit]) {
      expect(text).toContain(`commit ${OWN}`);
      expect(text).toContain('NOT verified');
      expect(text).toContain('no way to read this project');
      expect(text.match(/Git access/g)).toHaveLength(1);
    }
  });

  it('keeps the commit as a claim and never in merged_commit_sha (criterion 4)', async () => {
    noReader();
    const issue = await seed();
    await mark(issue, OWN);
    expect(await row(issue.id)).toMatchObject({ merged_commit_sha: null });
    expect(await claimOf(issue.id)).toBe(OWN);
  });

  it('stays refused where the project names no base branch (criterion 6)', async () => {
    noReader();
    await setBaseBranch(null);
    const issue = await seed({ sessionContext: {} });
    const refused = await refusal(() => mark(issue, OWN));
    expect(refused.code).toBe('COMMIT_UNVERIFIED');
    expect(refused.message).toContain('the project names no base branch');
    expect(await row(issue.id)).toMatchObject({ merged_at: null });
  });

  it('still refuses NO_WORK_EVIDENCE for an agent that names no commit', async () => {
    noReader();
    const issue = await seed({ sessionContext: {} });
    expect((await refusal(() => mark(issue, undefined))).code).toBe('NO_WORK_EVIDENCE');
  });
});

describe('ISS-1409 — the claim beside a mark that already stands (real Postgres)', () => {
  it("attaches to a person's bare mark, which names no commit, so the agent's issue can advance", async () => {
    noReader();
    const issue = await seed({ sessionContext: {} });
    await mark(issue, undefined, 'human');
    expect((await refusal(() => advance(issue.id, 'in_progress', 'developed'))).code).toBe(
      'NO_WORK_EVIDENCE',
    );
    const res = await mark(issue, OWN);
    expect(res.action).toBe('merged');
    expect(res.mark).toBe('asserted');
    expect(await claimOf(issue.id)).toBe(OWN);
    await advance(issue.id, 'in_progress', 'developed');
    expect((await row(issue.id)).status).toBe('developed');
  });

  it('keeps the first claim where a repeat names another commit, and says it did not stamp it', async () => {
    noReader();
    const issue = await seed();
    await mark(issue, OWN);
    const again = await mark(issue, FOREIGN);
    expect(again.action).toBe('already_merged');
    expect(await claimOf(issue.id)).toBe(OWN);
    expect(again.markDetail).toContain(OWN);
    expect(again.markDetail).not.toContain(FOREIGN);
  });

  it('records the merged pull request Forge holds, and no claim, where one exists', async () => {
    noReader();
    const pr = '0123456789abcdef0123456789abcdef01234567';
    repo.pullRequest = { commitSha: pr, mergedAt: new Date('2026-09-30T08:00:00Z') };
    const issue = await seed();
    const res = await mark(issue, OWN);
    expect(res.mark).toBe('observed');
    expect((await row(issue.id)).merged_commit_sha).toBe(pr);
    expect(await claimOf(issue.id)).toBeNull();
  });
});

describe('ISS-1409 — a reader that exists keeps every refusal (real Postgres)', () => {
  it.each([
    ['COMMIT_NOT_IN_REPOSITORY', FABRICATED],
    ['COMMIT_NOT_THIS_ISSUE', FOREIGN],
    ['COMMIT_NOT_THIS_ISSUE', UNDECLARED],
    ['COMMIT_NOT_LANDED', OFF_BASE],
  ] as const)('refuses %s for %s and writes nothing (criterion 5)', async (code, commit) => {
    const issue = await seed();
    const refused = await refusal(() => mark(issue, commit));
    expect(refused.code).toBe(code);
    expect(await row(issue.id)).toMatchObject({ merged_at: null, merged_commit_sha: null });
  });

  it.each(['read', 'mint'] as const)(
    'refuses COMMIT_UNVERIFIED where the configured reader fails (%s), writing nothing (criterion 6)',
    async (down) => {
      repo.down = down;
      const issue = await seed();
      const refused = await refusal(() => mark(issue, OWN));
      expect(refused.code).toBe('COMMIT_UNVERIFIED');
      expect(refused.message).toContain('not taken as evidence unchecked');
      expect(await row(issue.id)).toMatchObject({ merged_at: null });
    },
  );

  it("refuses a person's mark naming a commit where no reader is declared (criterion 13)", async () => {
    noReader();
    const issue = await seed({ sessionContext: {} });
    const refused = await refusal(() => mark(issue, OWN, 'human'));
    expect(refused.code).toBe('COMMIT_UNVERIFIED');
  });
});

describe('ISS-1409 — the claim is verified by a repeat mark once the repository can be read (real Postgres)', () => {
  it('upgrades to observed, stamping the full sha and clearing the claim (criterion 7)', async () => {
    noReader();
    const issue = await seed();
    await mark(issue, OWN);
    repo.down = null;
    const again = await mark(issue, undefined);
    expect(again.mark).toBe('observed');
    expect(again.action).toBe('merged');
    expect((await row(issue.id)).merged_commit_sha).toBe(OWN);
    expect(await claimOf(issue.id)).toBeNull();
  });

  it('upgrades when the repeat names the commit abbreviated (criterion 7)', async () => {
    noReader();
    const issue = await seed();
    await mark(issue, OWN);
    repo.down = null;
    await mark(issue, OWN.slice(0, 9));
    expect((await row(issue.id)).merged_commit_sha).toBe(OWN);
  });

  it.each([
    ['COMMIT_NOT_THIS_ISSUE', FOREIGN],
    ['COMMIT_NOT_IN_REPOSITORY', FABRICATED],
    ['COMMIT_NOT_LANDED', OFF_BASE],
  ] as const)(
    'refuses a claim the readable repository contradicts (%s) and leaves it standing (criterion 8)',
    async (code, claimed) => {
      noReader();
      const issue = await seed();
      await mark(issue, claimed);
      repo.down = null;
      const refused = await refusal(() => mark(issue, undefined));
      expect(refused.code).toBe(code);
      expect(await row(issue.id)).toMatchObject({ merged_commit_sha: null });
      expect(await claimOf(issue.id)).toBe(claimed);
    },
  );

  it('answers already_merged and says still not verified while no reader is declared (criterion 8)', async () => {
    noReader();
    const issue = await seed();
    await mark(issue, OWN);
    const again = await mark(issue, OWN);
    expect(again.action).toBe('already_merged');
    expect(again.mark).toBe('asserted');
    expect(again.markDetail).toContain('NOT verified');
    expect(await claimOf(issue.id)).toBe(OWN);
  });

  it('refuses COMMIT_UNVERIFIED on a repeat made against a configured reader that fails, keeping the claim (criterion 8)', async () => {
    noReader();
    const issue = await seed();
    await mark(issue, OWN);
    repo.down = 'read';
    const refused = await refusal(() => mark(issue, undefined));
    expect(refused.code).toBe('COMMIT_UNVERIFIED');
    expect(await claimOf(issue.id)).toBe(OWN);
    expect(await row(issue.id)).toMatchObject({ merged_commit_sha: null });
  });

  it('verifies on a closed issue, which cannot be unmarked (criterion 7)', async () => {
    noReader();
    const issue = await seed();
    await mark(issue, OWN);
    const { db } = current();
    await db.execute(sql`UPDATE issues SET status = 'closed' WHERE id = ${issue.id}`);
    repo.down = null;
    expect((await mark(issue, undefined)).mark).toBe('observed');
    expect((await row(issue.id)).merged_commit_sha).toBe(OWN);
  });
});

describe('ISS-1409 — unmark and the database keep the claim honest (real Postgres)', () => {
  it('clears the claim with the mark (criterion 9)', async () => {
    noReader();
    const issue = await seed();
    await mark(issue, OWN);
    await unmark(issue);
    expect(await claimOf(issue.id)).toBeNull();
    expect(await row(issue.id)).toMatchObject({ merged_at: null });
  });

  it('refuses a claimed commit with no mark, beside a merged commit, or that is no sha (criterion 9)', async () => {
    const { db } = current();
    const issue = await seed();
    const refusedBy = async (statement: ReturnType<typeof sql>) => {
      try {
        await db.execute(statement);
      } catch (err) {
        return (err as { cause?: { constraint_name?: string } }).cause?.constraint_name;
      }
      return 'went through';
    };
    const id = issue.id;
    for (const statement of [
      sql`UPDATE issues SET merged_claimed_commit = ${OWN} WHERE id = ${id}`,
      sql`UPDATE issues SET merged_at = now(), merged_commit_sha = ${OWN}, merged_claimed_commit = ${OWN} WHERE id = ${id}`,
      sql`UPDATE issues SET merged_at = now(), merged_claimed_commit = 'not a sha' WHERE id = ${id}`,
    ]) {
      expect(await refusedBy(statement)).toBe('issues_merged_claimed_commit_chk');
    }
  });
});
