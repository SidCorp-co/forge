/**
 * The world `release-batch/shipped-earlier.ts` is tested in: releases that shipped, rows marked at a
 * commit, the hold an aborted release leaves, and a fake host answering the repository's ancestry.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { insertComment } from '../../src/comments/service.js';
import { db } from '../../src/db/client.js';
import { markTrailLabel, NOT_STAMPED, recordMarkTrail } from '../../src/issues/mark-trail.js';
import { abortBlockedHold, writeReleaseHolds } from '../../src/release-batch/hold.js';
import { rows } from './factories.js';
import type { releaseWorld } from './release-world.js';

export const sha = (n: number) => n.toString(16).padStart(40, '0');
export const [A, B, N] = [sha(0xa), sha(0xb), sha(0xe)];
export const [C1, C2, C3] = [sha(0xc1), sha(0xc2), sha(0xc3)];

/** `commit -> the commits it holds`: a release commit holds what is listed for it. */
type History = Record<string, string[]>;
export const HISTORY: History = { [C1]: [A, C1], [C2]: [A, B, C1, C2] };

interface HostOptions {
  fail?: string;
  /** `base..head` -> the subjects of the commits the range holds. */
  ranges?: Record<string, string[]>;
  head?: string;
  /** Answers a range with fewer commits than it holds. */
  incomplete?: boolean;
}

export function host(history: History, opts: HostOptions = {}) {
  return async () =>
    ({
      compare: async (base: string, head: string) => {
        if (opts.fail) throw new Error(opts.fail);
        return (history[head] ?? []).includes(base) ? 'ahead' : 'diverged';
      },
      branchHead: async () => opts.head ?? C3,
      readRange: async (base: string, head: string) => {
        if (opts.fail) return { ok: false, reason: opts.fail };
        const subjects = opts.ranges?.[`${base}..${head}`] ?? [];
        return {
          ok: true,
          complete: !opts.incomplete,
          commits: subjects.map((message, i) => ({
            sha: sha(0x1000 + i),
            message,
            parents: [],
          })),
        };
      },
    }) as never;
}

export function shippedEarlierWorld(
  ids: () => { projectId: string },
  fx: ReturnType<typeof releaseWorld>,
) {
  /** A release that shipped: its finish record `finished` at `commit`, its ship stamp set. */
  async function shipped(version: string, commit: string, at: string): Promise<string> {
    const id = randomUUID();
    await db.execute(sql`
      INSERT INTO pipeline_runs (id, project_id, kind, status, started_at, release_version, release_released_at, metadata)
      VALUES (${id}, ${ids().projectId}, 'system', 'completed', ${at}::timestamptz, ${version}, ${at}::timestamptz,
              ${JSON.stringify({
                source: 'release-batch',
                finish: {
                  requestId: randomUUID(),
                  state: 'finished',
                  commit,
                  version: 1,
                },
              })}::jsonb)
    `);
    return id;
  }

  /** A waiting row marked as merged at `commit`, as Forge observed it. */
  async function marked(commit: string): Promise<string> {
    const id = await fx.insertIssue('awaiting_release');
    await db.execute(sql`UPDATE issues SET merged_commit_sha = ${commit} WHERE id = ${id}`);
    return id;
  }

  /** A waiting row carrying an `asserted` mark: somebody's word, naming no commit. */
  const asserted = () => fx.insertIssue('awaiting_release');

  /**
   * What the marker leaves for a mark or an unmark (`merge-marker.ts` `writeMarkTrail`): the audit
   * comment, worded as the kernel words it, and the record the trail is read from
   * (`issues/mark-trail.ts`), in one transaction. A mark whose comment says `NOT stamped` did not
   * stamp, so its record says so.
   */
  async function trail(id: string, op: 'mark' | 'unmark', commit: string | null, rest: string) {
    const [issue] = await rows<{ by: string }>(
      sql`SELECT created_by_id AS by FROM issues WHERE id = ${id}`,
    );
    const authorId = issue?.by ?? '';
    const body = `${markTrailLabel(op, op === 'mark' ? 'dev' : undefined, commit)}${rest}`;
    await db.transaction(async (tx) => {
      const { row } = await insertComment(
        { issueId: id, authorId, authorDeviceId: null, body, parentId: null },
        tx,
      );
      const base = {
        issueId: id,
        actor: { type: 'user' as const, id: authorId, agency: 'agent' as const },
        commentId: row.id,
      };
      await recordMarkTrail(
        tx,
        op === 'mark'
          ? { ...base, op, target: 'dev', commit, stamped: !rest.includes(NOT_STAMPED) }
          : { ...base, op },
      );
    });
  }

  /** A mark claiming `commit`, as the marker writes it. */
  const claim = (id: string, commit: string, tail = '') =>
    trail(
      id,
      'mark',
      commit,
      `${tail}\nthis mark is a claim: commit ${commit} is recorded here as this call's claim`,
    );

  /** A mark naming no commit, as the marker writes it. */
  const bareMark = (id: string, note: string) =>
    trail(
      id,
      'mark',
      null,
      ` — ${note}\nthis mark is a CLAIM Forge did not observe: no commit is recorded`,
    );

  /** An unmark, as the marker writes it. */
  const unmark = (id: string, note: string) => trail(id, 'unmark', null, ` — ${note}`);

  /** A comment somebody typed through a comment door: text only, whatever shape it has. */
  const typed = (id: string, body: string) => fx.postComment(id, body);

  async function runOf(id: string) {
    const [row] = await rows<{ status: string; claim: string | null }>(sql`
      SELECT status, release_batch_run_id AS claim FROM issues WHERE id = ${id}
    `);
    return row;
  }

  async function abortHold(id: string): Promise<void> {
    const { projectId } = ids();
    await writeReleaseHolds({
      projectId,
      issueIds: [id],
      holdFor: () =>
        abortBlockedHold({
          projectId,
          version: '0.4.0-dev.2',
          reason: 'Nothing to release: already shipped.',
          waitingFor: 'record these issues as shipped',
        }),
      now: new Date(),
    });
  }

  return { shipped, marked, asserted, claim, bareMark, unmark, typed, runOf, abortHold };
}
