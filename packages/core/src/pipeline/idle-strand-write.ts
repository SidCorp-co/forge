// Writing what the idle-issues pass found onto the row, and raising it to a person when it needs one.

import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { leaseHolderOf } from '../issues/index.js';
import { formatIssueRef } from '../lib/issue-ref.js';
import { logger } from '../lib/logger.js';
import type { CandidateRow, StrandRecord } from './idle-issues.js';
import { emitNotification } from './ports.js';
import { sweepGroupKey } from './stranded-issues.js';

function strandResolutionKey(issueId: string): string {
  return `issue:${issueId}:idle`;
}

/**
 * Whether the finding already on the row says the same thing as the one just built.
 *
 * `at` is the only field that moves on its own, and it is what makes the record say how long the
 * row has been reported rather than how long ago the last tick was — so an unchanged finding is
 * left exactly as it was written.
 */
export function unchangedStrand(held: unknown, next: StrandRecord): boolean {
  if (held === null || typeof held !== 'object') return false;
  const { at: _next, ...rest } = next;
  const { at: _held, ...heldRest } = held as StrandRecord;
  return canonical(heldRest) === canonical(rest);
}

/** Key order, which `jsonb` normalises on the way in and an object literal does not. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v) =>
    v !== null && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)),
        )
      : v,
  );
}

/**
 * Write the finding onto the row, and release a lapsed lease. Guarded on the lease value read, under
 * the row lock, so a claim landing between read and write wins and this pass skips the row. The
 * finding goes through `jsonb_set` on its own key, so a concurrent write to another key survives;
 * the release goes to the lease's home, `issue_work_state` (ISS-54). `updated_at` is left alone:
 * it has no trigger, and a swept row must not read as freshly worked.
 */
export async function writeStrand(args: {
  row: CandidateRow;
  record: StrandRecord;
  release: boolean;
  now: Date;
}): Promise<boolean> {
  const { row, record, release, now } = args;
  const entry = JSON.stringify({
    at: now.toISOString(),
    how: 'swept',
    holder: leaseHolderOf(row.lease),
    status: row.status,
  });
  const read = row.lease === null || row.lease === undefined ? null : JSON.stringify(row.lease);
  return db.transaction(async (tx) => {
    const held = (await tx.execute(sql`
      SELECT 1 FROM issues i
       WHERE i.id = ${row.id}
         AND coalesce((SELECT w.lease FROM issue_work_state w WHERE w.issue_id = i.id), 'null'::jsonb)
             IS NOT DISTINCT FROM coalesce(${read}::jsonb, 'null'::jsonb)
       FOR UPDATE OF i
    `)) as unknown as Array<unknown>;
    if (held.length === 0) {
      logger.info(
        { issueId: row.id },
        'idle-issues: the lease moved between the read and the write — the row is left as the other writer left it',
      );
      return false;
    }
    await tx.execute(sql`
      UPDATE issues i
         SET session_context = jsonb_set(coalesce(i.session_context, '{}'::jsonb), '{strand}', ${JSON.stringify(record)}::jsonb, true)
       WHERE i.id = ${row.id}
    `);
    if (release) {
      await tx.execute(sql`
        UPDATE issue_work_state w
           SET lease = jsonb_set(
                 jsonb_set(w.lease, '{stopped}', to_jsonb(${now.toISOString()}::text), true),
                 '{history}',
                 (CASE WHEN jsonb_typeof(w.lease -> 'history') = 'array'
                       THEN w.lease -> 'history' ELSE '[]'::jsonb END) || ${entry}::jsonb,
                 true),
               updated_at = now()
         WHERE w.issue_id = ${row.id} AND jsonb_typeof(w.lease) = 'object'
      `);
    }
    return true;
  });
}

/** A reason closed by one full stop: a release hold's reason already ends in its own. */
function asSentence(reason: string): string {
  return /[.!?]$/.test(reason.trimEnd()) ? reason.trimEnd() : `${reason}.`;
}

export async function surface(args: {
  row: CandidateRow;
  record: StrandRecord;
  admins: ReadonlyMap<string, string[]>;
  now: Date;
}): Promise<number> {
  const { row, record, admins, now } = args;
  const recipients = admins.get(row.project_id) ?? [];
  if (recipients.length === 0) return 0;
  const ref = formatIssueRef(row.issue_prefix, row.iss_seq);
  // `shared` and `malformed` are the two readings the classifier refuses to draw a conclusion
  // from, so the headline may not draw one either: what was established there is that no live work
  // could be confirmed, which is a different sentence from nobody working it.
  const unconfirmed = record.lease === 'shared' || record.lease === 'malformed';
  const headline = unconfirmed
    ? `${ref} reads \`${record.status}\` and no live work could be confirmed — ${row.project_name}`
    : `${ref} reads \`${record.status}\` and nothing is working it — ${row.project_name}`;
  const opening = unconfirmed
    ? `${ref} has read \`${record.status}\` since ${record.since} with no live job or run behind it, and a lease that establishes nothing either way.`
    : `${ref} has read \`${record.status}\` since ${record.since} with no live job, run or lease behind it.`;
  const sent = await emitNotification({
    recipients,
    projectId: row.project_id,
    issueId: row.id,
    type: 'issue_stranded',
    resolutionKey: strandResolutionKey(row.id),
    groupKey: sweepGroupKey('idle-issues', now),
    groupTitle: 'Issues in a live status with no live work behind them',
    title: headline,
    body:
      `${opening} ${asSentence(record.reason)} ` +
      `It is waiting for ${record.waitingFor}, and ${record.owes === 'human' ? 'a person' : 'an agent'} owes the next move. ` +
      'Nothing was moved: the finding is on the issue itself, under `strand`.',
  });
  return sent?.delivered ?? 0;
}
