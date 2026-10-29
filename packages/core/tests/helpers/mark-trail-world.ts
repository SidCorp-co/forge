/**
 * Marks as the marker writes them (`merge-marker.ts` `writeMarkTrail`): the audit comment and the
 * record `issues/mark-trail.ts` reads, so a test reads a mark's time and claim as the kernel does.
 */

import { sql } from 'drizzle-orm';
import { insertComment } from '../../src/comments/service.js';
import { db } from '../../src/db/client.js';
import { markTrailLabel, NOT_STAMPED, recordMarkTrail } from '../../src/issues/mark-trail.js';
import { rows } from './factories.js';

export const sha = (n: number) => n.toString(16).padStart(40, '0');
export const [A, B, N] = [sha(0xa), sha(0xb), sha(0xe)];
export const [C1, C2, C3] = [sha(0xc1), sha(0xc2), sha(0xc3)];

export function markTrailWorld() {
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

  return { claim, bareMark, unmark };
}
