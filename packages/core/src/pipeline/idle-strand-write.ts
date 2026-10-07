// Writing what the idle-issues pass found onto the row, and raising it to a person when it needs one.

import { leaseHolderOf, writeIssueStrand } from '../issues/index.js';
import { stableStringify } from '../lib/canonical-json.js';
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
  return stableStringify(heldRest) === stableStringify(rest);
}

/**
 * Write the finding onto the row, and release a lapsed lease, through the issues kernel's writer.
 * Guarded on the lease value read, so a claim landing between read and write wins and this pass
 * skips the row.
 */
export async function writeStrand(args: {
  row: CandidateRow;
  record: StrandRecord;
  release: boolean;
  now: Date;
}): Promise<boolean> {
  const { row, record, release, now } = args;
  const at = now.toISOString();
  const written = await writeIssueStrand({
    issueId: row.id,
    leaseRead: row.lease,
    record,
    release: release
      ? { at, entry: { at, how: 'swept', holder: leaseHolderOf(row.lease), status: row.status } }
      : null,
  });
  if (!written) {
    logger.info(
      { issueId: row.id },
      'idle-issues: the lease moved between the read and the write — the row is left as the other writer left it',
    );
  }
  return written;
}

/** A reason closed by one full stop: a release hold's reason already ends in its own. */
function asSentence(reason: string): string {
  return /[.!?]$/.test(reason.trimEnd()) ? reason.trimEnd() : `${reason}.`;
}

export async function surface(args: {
  row: CandidateRow;
  record: StrandRecord;
  admins: ReadonlyMap<string, string[]>;
}): Promise<number> {
  const { row, record, admins } = args;
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
    groupKey: sweepGroupKey('idle-issues', row.project_id),
    groupTitle: 'Issues in a live status with no live work behind them',
    title: headline,
    body:
      `${opening} ${asSentence(record.reason)} ` +
      `It is waiting for ${record.waitingFor}, and ${record.owes === 'human' ? 'a person' : 'an agent'} owes the next move. ` +
      'Nothing was moved: the finding is on the issue itself, under `strand`.',
  });
  return sent.delivered;
}
