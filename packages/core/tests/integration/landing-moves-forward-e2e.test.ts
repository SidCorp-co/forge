/**
 * ISS-1421 round 7 — a later landing of the same issue moves its merge mark forward, against a real
 * Postgres and a stand-in for the project's repository (`tests/helpers/commit-landing-fixture.ts`).
 *
 * Before it, the observed commit was written once under an empty column and the merged pull request
 * read was the oldest, so ISS-1421 read the commit of its first round after three more had merged.
 * Only Postgres can fail the move: it is a compare-and-swap on the column the row still holds.
 */

import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.JWT_SECRET ??= 'integration-test-secret-padded-to-32-chars-long';
process.env.DEVICE_TOKEN_PEPPER ??= 'integration-test-pepper-padded-to-32-chars-long';

import { refusal, repo, SEQ, useCommitLandingWorld } from '../helpers/commit-landing-fixture.js';

vi.mock('../../src/issues/merge-record.js', async (importOriginal) =>
  (await import('../helpers/commit-landing-fixture.js')).fakeMergeRecord(await importOriginal()),
);
vi.mock('../../src/integrations/github/client.js', async (importOriginal) =>
  (await import('../helpers/commit-landing-fixture.js')).fakeGitHubClient(await importOriginal()),
);

const world = useCommitLandingWorld();
const { seed, mark, row, comments } = world;

/** One line of history on main: OLDER, then FIRST, SECOND and THIRD, each carrying the ones before. */
const OLDER = '0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a';
const FIRST = '1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a';
const SECOND = '2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b';
const THIRD = '3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c';
/** On main, declaring the issue, and on neither side of FIRST's line. */
const SIDE = '4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d';

const moved = (from: string, to: string) =>
  `The landing moved from commit ${from} to commit ${to}, which carries it.`;

beforeEach(() => {
  const own = (round: string) =>
    `Merge pull request #10${round} from SidCorp-co/ISS-${SEQ}-r${round}`;
  repo.commits.set(OLDER, { message: own('0'), on: ['main'] });
  repo.commits.set(FIRST, { message: own('1'), on: ['main'], after: [OLDER] });
  repo.commits.set(SECOND, { message: own('2'), on: ['main'], after: [OLDER, FIRST] });
  repo.commits.set(THIRD, { message: own('3'), on: ['main'], after: [OLDER, FIRST, SECOND] });
  repo.commits.set(SIDE, { message: own('9'), on: ['main'] });
});

/** An issue whose mark holds FIRST, observed: the state ISS-1421 stood in after its first round. */
async function markedAtFirst() {
  const issue = await seed();
  const first = await mark(issue, FIRST);
  expect(first.mark).toBe('observed');
  expect((await row(issue.id)).merged_commit_sha).toBe(FIRST);
  return issue;
}

describe('a later commit of the same issue moves the mark (criteria 102, 105, 109)', () => {
  it('marked at FIRST, then at SECOND by an agent, reads SECOND and says it moved', async () => {
    const issue = await markedAtFirst();

    const res = await mark(issue, SECOND);

    expect(res.action).toBe('merged');
    expect(res.movedFrom).toBe(FIRST);
    expect(res.markDetail).toContain(moved(FIRST, SECOND));
    expect(res.markDetail).not.toContain('changed nothing');
    expect((await row(issue.id)).merged_commit_sha).toBe(SECOND);
    expect((await comments(issue.id)).at(-1)).toContain(moved(FIRST, SECOND));
    expect(res.issue.mergedCommitSha).toBe(SECOND);
  });

  it('moves it for a person naming the later commit too', async () => {
    const issue = await markedAtFirst();
    const res = await mark(issue, SECOND, 'human');
    expect(res.movedFrom).toBe(FIRST);
    expect((await row(issue.id)).merged_commit_sha).toBe(SECOND);
  });

  it('moves it again for a third round', async () => {
    const issue = await markedAtFirst();
    await mark(issue, SECOND);
    const res = await mark(issue, THIRD);
    expect(res.movedFrom).toBe(SECOND);
    expect((await row(issue.id)).merged_commit_sha).toBe(THIRD);
  });
});

describe('a mark naming no commit reads the most recently merged pull request (criterion 103)', () => {
  /** Two merged pull requests on one binding: FIRST's, then SECOND's a day later. */
  async function seedTwoRounds(issueId: string) {
    const { db, projectId } = world.current();
    const [owner] = await db.execute<{ created_by_id: string }>(
      sql`SELECT created_by_id FROM issues WHERE id = ${issueId}`,
    );
    const [conn] = await db.execute<{ id: string }>(sql`
      INSERT INTO integration_connections (owner_type, owner_id, provider, display_name)
      VALUES ('user', ${(owner as { created_by_id: string }).created_by_id}, 'github', 'gh')
      RETURNING id
    `);
    const [binding] = await db.execute<{ id: string }>(sql`
      INSERT INTO integration_bindings (project_id, connection_id, provider, role, config)
      VALUES (${projectId}, ${(conn as { id: string }).id}, 'github', 'service', '{}'::jsonb)
      RETURNING id
    `);
    const rounds: Array<[number, string, string]> = [
      [1, FIRST, '2026-10-16T09:00:00Z'],
      [2, SECOND, '2026-10-17T09:00:00Z'],
    ];
    for (const [n, commit, at] of rounds) {
      await db.execute(sql`
        INSERT INTO repo_pull_requests
          (project_id, binding_id, issue_id, number, repo_full_name, title, state,
           head_ref, head_sha, base_ref, base_sha, merged_at, merge_commit_sha)
        VALUES (${projectId}, ${(binding as { id: string }).id}, ${issueId}, ${n},
                'SidCorp-co/specimen', 'pr', 'merged', ${`ISS-${SEQ}-r${n}`}, 'headsha', 'main',
                'basesha', ${at}::timestamptz, ${commit})
      `);
    }
  }

  it('moves the mark to the later pull request, not the first one merged', async () => {
    const issue = await markedAtFirst();
    await seedTwoRounds(issue.id);

    const res = await mark(issue, undefined);

    expect(res.movedFrom).toBe(FIRST);
    expect((await row(issue.id)).merged_commit_sha).toBe(SECOND);
  });
});

describe('a commit the mark already carries changes nothing (criteria 69, 107)', () => {
  it.each([
    ['the same commit', FIRST, null],
    ['an abbreviation of it', FIRST.slice(0, 9), null],
    ['a commit it already carries', OLDER, `Commit ${OLDER} is already in commit ${FIRST}`],
  ])('answers already merged for %s', async (_, commit, aside) => {
    const issue = await markedAtFirst();
    const res = await mark(issue, commit);
    expect(res.action).toBe('already_merged');
    expect(res.movedFrom).toBeNull();
    expect(res.markDetail).toMatch(/^Already marked merged on .*, so this call changed nothing\./);
    if (aside) expect(res.markDetail).toContain(aside);
    expect((await row(issue.id)).merged_commit_sha).toBe(FIRST);
  });
});

describe('a commit on another line is a different landing (criteria 106, 112)', () => {
  it('refuses LANDING_NOT_DESCENDANT naming both commits and Unmark, and writes nothing', async () => {
    const issue = await markedAtFirst();
    const before = await comments(issue.id);

    const refused = await refusal(() => mark(issue, SIDE));

    expect(refused.code).toBe('LANDING_NOT_DESCENDANT');
    expect(refused.message).toContain(`Commit ${SIDE} does not descend from commit ${FIRST}`);
    expect(refused.message).toContain('use Unmark, then Mark merged again');
    expect((await row(issue.id)).merged_commit_sha).toBe(FIRST);
    expect(await comments(issue.id)).toEqual(before);
  });
});

describe('where the repository cannot say whether it descends (criteria 108, 113)', () => {
  it('keeps the mark, and says it was not moved with the reason quoted', async () => {
    const issue = await markedAtFirst();
    repo.down = 'compare';

    const res = await mark(issue, SECOND);

    expect(res.action).toBe('already_merged');
    expect(res.markDetail).toContain(
      `Commit ${SECOND} was not compared with commit ${FIRST}, so the landing stays at ${FIRST}. Mark it again once Forge can read the repository. The reason:\n> `,
    );
    // The reason stands quoted on the last line, and nothing sends the reader to Unmark.
    expect(res.markDetail.split('\n').at(-1)).toMatch(/^> /);
    expect(res.markDetail).not.toContain('use Unmark');
    expect((await row(issue.id)).merged_commit_sha).toBe(FIRST);
    expect((await comments(issue.id)).at(-1)).toContain('The reason:');
  });
});

describe('a merge Forge observed moves the mark the same way (criteria 104, 105, 111)', () => {
  const at = new Date('2026-10-18T00:00:00Z');
  const stamp = async (issueId: string, sha: string) => {
    const { stampObservedMerge } = await import('../../src/issues/landing-advance.js');
    return stampObservedMerge({
      issueId,
      projectId: world.current().projectId,
      candidate: { sha, at, via: 'event' },
    });
  };

  it('moves a mark held at FIRST to a later merge, and comments naming both', async () => {
    const issue = await markedAtFirst();
    const res = await stamp(issue.id, SECOND);
    expect(res.wrote).toBe(true);
    expect((await row(issue.id)).merged_commit_sha).toBe(SECOND);
    expect((await comments(issue.id)).at(-1)).toBe(moved(FIRST, SECOND));
  });

  it('a redelivery of the same merge says nothing more', async () => {
    const issue = await markedAtFirst();
    await stamp(issue.id, SECOND);
    const said = await comments(issue.id);
    expect((await stamp(issue.id, SECOND)).wrote).toBe(false);
    expect(await comments(issue.id)).toEqual(said);
  });

  it('leaves a mark a merge on another line does not carry, saying so once', async () => {
    const issue = await markedAtFirst();
    expect((await stamp(issue.id, SIDE)).wrote).toBe(false);
    await stamp(issue.id, SIDE);
    expect((await row(issue.id)).merged_commit_sha).toBe(FIRST);
    const said = (await comments(issue.id)).filter((c) => c.includes(SIDE));
    expect(said).toEqual([
      `A pull request of this issue merged at commit ${SIDE}. It does not descend from commit ${FIRST}, so the landing stays at ${FIRST}.`,
    ]);
  });

  it.each([
    ['SECOND then THIRD', [SECOND, THIRD], [moved(FIRST, SECOND), moved(SECOND, THIRD)]],
    ['THIRD then SECOND', [THIRD, SECOND], [moved(FIRST, THIRD)]],
  ])('two later merges that both read FIRST end at THIRD, writing %s', async (_, order, said) => {
    const issue = await markedAtFirst();
    // The next is let go only once the row holds the one before it: the order is the test's.
    const settled = async (sha: string) => {
      for (let polls = 0; polls < 400; polls += 1) {
        if ((await row(issue.id)).merged_commit_sha === sha) return;
        await new Promise((r) => setTimeout(r, 5));
      }
      throw new Error(`${sha} never reached the row, so the write order was not the one named`);
    };
    repo.hold = { order, arrived: new Map(), settled };
    await Promise.all([stamp(issue.id, SECOND), stamp(issue.id, THIRD)]);
    expect(repo.hold?.failed).toBeUndefined();
    expect((await row(issue.id)).merged_commit_sha).toBe(THIRD);
    expect((await comments(issue.id)).filter((c) => c.startsWith('The landing moved'))).toEqual(
      said,
    );
  });
});
