// @gate-input whole-tree — it serves a real repository through a fake ssh on PATH, which the root-walk guard cannot see into.
/**
 * ISS-1421 r9 — criteria 109, 122 and 132 need a repository Forge can read, which beta had none of
 * for its judge. Here the repository is a real bare one behind a fake `ssh`, read through the
 * project's deploy key (`tests/helpers/git-host-fixture.ts`), and every mark goes through the real
 * mark path against a real Postgres: what git says is what the mark answers.
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

process.env.JWT_SECRET ??= 'integration-test-secret-padded-to-32-chars-long';
process.env.DEVICE_TOKEN_PEPPER ??= 'integration-test-pepper-padded-to-32-chars-long';

import { keyUnknown } from '../../src/git/host-answers.fixture.js';
import { issueRefPattern, liveReachOf } from '../../src/projects/live-reach.js';
import { SEQ, useCommitLandingWorld } from '../helpers/commit-landing-fixture.js';
import {
  attachDeployKey,
  GITLAB_URL,
  type GitHost,
  startGitHost,
} from '../helpers/git-host-fixture.js';

vi.mock('node:dns', async (importOriginal) =>
  (await import('../helpers/git-host-fixture.js')).publicDns(await importOriginal()),
);

const { seed, mark, row, comments, current } = useCommitLandingWorld();

let host: GitHost;
const at: Record<string, string> = {};
const s = (sha: string | undefined) => (sha as string).slice(0, 7);

beforeAll(() => {
  host = startGitHost();
  at.root = host.commit('main', 'chore: root');
  at.first = host.commit('main', `fix(core): round one (ISS-${SEQ})`);
  at.second = host.commit('main', `fix(core): round two (ISS-${SEQ})`);
  at.other = host.commit('main', 'fix(core): another issue entirely (ISS-1316)');
  host.publish();
});

afterAll(() => host.close());

beforeEach(async () => {
  host.answering(null);
  const { db, projectId } = current();
  await attachDeployKey(db, projectId, GITLAB_URL);
});

/** What a person reads of a mark: no whole sha, short sentences of ours and of the quoted reason. */
function readsShort(text: string): void {
  expect(text).not.toMatch(/[0-9a-f]{40}/);
  const lines = text.split('\n').filter((l) => l.trim() !== '' && l.trim() !== '>');
  const sentences = (ls: string[]) => ls.join(' ').split(/(?<=\.)\s+(?=[A-Z])/);
  const ours = sentences(lines.filter((l) => !l.startsWith('>')));
  expect(ours.length, text).toBeLessThanOrEqual(4);
  // ISS-1421 r9: the quoted reason is three short sentences at most, the host's own line apart as code.
  const quoted = lines.filter((l) => l.startsWith('> '));
  const reason = sentences(quoted.filter((l) => !l.startsWith('> `')).map((l) => l.slice(2)));
  expect(reason.length, text).toBeLessThanOrEqual(3);
  for (const one of [...ours, ...reason]) {
    expect(one.split(/\s+/).length, one).toBeLessThanOrEqual(20);
    expect(one, one).not.toMatch(/ — /);
  }
  for (const host of quoted.filter((l) => l.startsWith('> `'))) expect(host).toMatch(/^> `[^`]+`$/);
}

// What the rail shows of it, and its refresh, are the web's: merge-marker-refresh.test.tsx.
describe('a mark Forge observed, then moved by a later commit: the landing core serves (criteria 109, 132)', () => {
  it('reads the later commit as the landing on the row, the issue served, the thread and live reach', async () => {
    const issue = await seed();

    const first = await mark(issue, at.first);
    expect(first.mark).toBe('observed');
    expect(first.markDetail).toBe(
      `Forge saw this merge land at commit ${s(at.first)}, on main of ${GITLAB_URL}.`,
    );
    expect((await row(issue.id)).merged_commit_sha).toBe(at.first);

    const later = await mark(issue, at.second);

    expect(later.action).toBe('merged');
    expect(later.movedFrom).toBe(at.first);
    // The rail reads the whole commit off the issue it is served, and shows seven of it.
    expect(later.issue.mergedCommitSha).toBe(at.second);
    expect((await row(issue.id)).merged_commit_sha).toBe(at.second);
    const said = (await comments(issue.id)).at(-1) as string;
    expect(said).toBe(
      `Marked merged into main.\nThe landing moved from commit ${s(at.first)} to commit ${s(at.second)}, which carries it.`,
    );
    readsShort(said);

    // Live reach reads the issue's landing off the same column: the later commit is its own merge.
    const reach = liveReachOf(
      { issSeq: SEQ, mergedAt: later.issue.mergedAt, mergedCommitSha: later.issue.mergedCommitSha },
      {
        kind: 'measured',
        baseBranch: 'main',
        liveBranch: 'production',
        baseSha: at.second as string,
        liveSha: at.root as string,
        aheadBy: 1,
        commits: [{ sha: at.second as string, message: 'chore: unrelated subject', parents: [] }],
        complete: true,
        startedAt: new Date(),
      },
      issueRefPattern([]),
    );
    expect(reach?.state).toBe('not_on_live');
    expect(reach && 'evidence' in reach ? reach.evidence : []).toEqual([
      { sha: at.second, subject: 'chore: unrelated subject', via: 'merged_commit' },
    ]);
  }, 60_000);
});

describe("a person's mark naming a commit the repository holds (criterion 122)", () => {
  it('says the commit is noted in the comment only and the mark names none, as a repeat says', async () => {
    const issue = await seed({ sessionContext: {} });

    const res = await mark(issue, (at.other as string).slice(0, 10), 'human');

    const noted = `Commit ${s(at.other)} is in \`${GITLAB_URL}\`, and is noted in the comment only. Forge did not see this merge, so the mark is a claim that names no commit.`;
    expect(res.mark).toBe('asserted');
    expect(res.markDetail).toBe(noted.replace(`\`${GITLAB_URL}\``, GITLAB_URL));
    expect(res.namedCommit).toBe(at.other);
    // The row keeps no commit of a person's: the rail reads a claim naming none.
    const held = await row(issue.id);
    expect(held.merged_commit_sha).toBeNull();
    expect(held.merged_claimed_commit).toBeNull();
    expect(res.issue.mergedCommitSha).toBeNull();
    const said = (await comments(issue.id)).at(-1) as string;
    expect(said).toBe(`Marked merged into main.\n${noted}`);
    readsShort(said);

    const again = await mark({ ...issue, mergedAt: new Date() }, undefined, 'human');
    expect(again.action).toBe('already_merged');
    expect(again.markDetail).toContain('The mark stays a claim that names no commit.');
  }, 60_000);
});

describe('a host that stops answering leaves an observed mark where it stood (criterion 113)', () => {
  it('answers where the mark stays, quoting the host, and offers no mark naming no commit', async () => {
    const issue = await seed();
    await mark(issue, at.first);
    host.answering(keyUnknown('gitlab.com'));

    const res = await mark({ ...issue, mergedAt: new Date() }, at.second);

    expect(res.action).toBe('already_merged');
    expect(res.movedFrom).toBeNull();
    expect(res.markDetail.split('\n')[0]).toBe(
      `The mark stays at commit ${s(at.first)}. Forge could not check commit ${s(at.second)} against the repository. Mark it again once it can.`,
    );
    expect(res.markDetail).not.toContain('naming no commit');
    expect((await row(issue.id)).merged_commit_sha).toBe(at.first);
    // Criterion 125: the host's own address, quoted beneath, is code in the thread.
    const said = (await comments(issue.id)).at(-1) as string;
    expect(said).toContain('\n>\n> `git@gitlab.com: Permission denied (publickey).`');
    expect(said).not.toMatch(/(?<!`)git@gitlab\.com(?!`|:sid)/);
    readsShort(said);
    const { db } = current();
    const [n] = await db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM comments WHERE issue_id = ${issue.id}`,
    );
    expect(n?.n).toBe(2);
  }, 60_000);
});
