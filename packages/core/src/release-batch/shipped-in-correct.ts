/**
 * A shipped-in record that named the wrong release, corrected (ISS-846, FB-452). A record closes its
 * issue at once (`shipped-in.ts:recordShippedIn`), so a second one is refused for an issue no longer
 * waiting; this is the way to say the first was wrong. It is the same call carrying `corrects`, the
 * version the issue ships in now, and a `reason`, and it moves only which release lists the issue:
 * the issue stays `closed`.
 *
 * The new version passes every check a first record passes (`shipped-in.ts:shippableRelease`). The
 * release it replaces keeps the record that named it, marked superseded with who, when and why
 * (`metadata.shippedInCorrections`), and lists the issue no longer (`metadata.rosterSuperseded`,
 * subtracted by every reader of what a release carries: `versions.ts:issueIdsOf`,
 * `pipeline/release-runs.ts:shippedReleasesOf`). The release it now ships in lists it as a shipped-in
 * record would have (`rosterClosed`) and keeps the same correction. The issue's activity records it
 * under `issue.shippedInCorrected`, and a notice names both versions and the reason.
 */

import type { ReleaseShippedInCorrection } from '@forge/contracts/releases';
import { sql } from 'drizzle-orm';
import { postIssueNotice } from '../comments/index.js';
import { db } from '../db/client.js';
import { issues } from '../db/schema.js';
import { filingAnsweredBy, issueKeysAndTitles, recordActivityTx } from '../issues/index.js';
import { peopleOf } from '../lib/people.js';
import { runWearingVersion, shippedReleasesOf, writeRunMetadata } from '../pipeline/index.js';
import { refuseRelease } from './refuse.js';
import { readShippedInRow, shippableRelease } from './shipped-in.js';

/** The activity a correction leaves on its issue. */
export const SHIPPED_IN_CORRECTED = 'issue.shippedInCorrected';

export interface CorrectShippedInArgs {
  projectId: string;
  issueId: string;
  /** The release the issue truly shipped in. */
  version: string | null;
  /** The version the issue is recorded shipping in now, which this replaces. */
  corrects: string;
  /** Why the record it replaces was wrong. */
  reason: string | undefined;
  /** What the agent read to say so: the git command and its answer. */
  evidence: string;
  userId: string;
}

export interface CorrectShippedInResult {
  issueId: string;
  version: string;
  runId: string;
  closed: true;
  corrected: { version: string; runId: string };
}

/** One correction, as both releases keep it: append-only, never edited away. */
export interface CorrectionEntry {
  issueId: string;
  /** `superseded` on the release that no longer lists the issue, `corrected` on the one that now does. */
  role: 'superseded' | 'corrected';
  from: string;
  to: string;
  reason: string;
  evidence: string;
  by: string;
  at: string;
}

const correctsPath = '/corrects';

export async function correctShippedIn(
  args: CorrectShippedInArgs,
): Promise<CorrectShippedInResult> {
  const reason = args.reason?.trim();
  if (!reason) {
    throw refuseRelease(
      'RELEASE_SHIPPED_IN_REASON_MISSING',
      `A correction of a shipped-in record says why the record it replaces was wrong: send \`reason\` (10 to 2000 characters) beside \`corrects: "${args.corrects}"\`.`,
      '/reason',
    );
  }
  if (args.version === null) {
    throw refuseRelease(
      'RELEASE_SHIPPED_IN_CORRECTION_NONE',
      `A correction names the shipped release that holds the landing instead of ${args.corrects}: send \`version: "<that release>"\`. A closed issue no shipped release holds is not corrected here; reopen it.`,
      '/version',
    );
  }
  const row = await readShippedInRow(args.projectId, args.issueId);
  if (!row) {
    throw refuseRelease(
      'RELEASE_SHIPPED_IN_NOT_CORRECTABLE',
      `No issue ${args.issueId} is on this project.`,
      '/issueId',
    );
  }
  const current = (await shippedReleasesOf(args.projectId, [row.id])).get(row.id) ?? null;
  const from = current ? await runWearingVersion(args.projectId, current.version) : null;
  const viaRecord =
    from !== null &&
    idsIn(from.metadata.rosterClosed).includes(row.id) &&
    !idsIn(from.metadata.issueIds).includes(row.id);
  if (row.status !== 'closed' || !current || !from || !viaRecord || !row.landedAt) {
    throw refuseRelease(
      'RELEASE_SHIPPED_IN_NOT_CORRECTABLE',
      row.status !== 'closed'
        ? `ISS-${row.issSeq} is \`${row.status}\`, so no shipped-in record closed it and there is none to correct: send the record without \`corrects\` and \`reason\`.`
        : !current || !from
          ? `ISS-${row.issSeq} is \`closed\` and no shipped release lists it, so there is no shipped-in record to correct.`
          : !viaRecord
            ? `ISS-${row.issSeq} shipped on release ${current.version}'s own roster, not through a shipped-in record, so there is no shipped-in record to correct.`
            : `ISS-${row.issSeq} holds no merged mark, so there is no landing a release could have shipped.`,
      '/issueId',
    );
  }
  if (args.corrects !== current.version) {
    throw refuseRelease(
      'RELEASE_SHIPPED_IN_CORRECTS_MISMATCH',
      `ISS-${row.issSeq} is recorded as shipped in ${current.version}, not ${args.corrects}: \`corrects\` names the version it ships in now, so send \`corrects: "${current.version}"\`.`,
      correctsPath,
    );
  }
  if (args.version === current.version) {
    throw refuseRelease(
      'RELEASE_SHIPPED_IN_CORRECTION_SAME',
      `ISS-${row.issSeq} already ships in ${current.version}: a correction names a different shipped release in \`version\`.`,
      '/version',
    );
  }
  const filing = await filingAnsweredBy(row.id);
  const to = await shippableRelease(
    args.projectId,
    { issSeq: row.issSeq, landedAt: row.landedAt },
    args.version,
    filing,
  );

  const at = new Date().toISOString();
  const entry = (role: CorrectionEntry['role']): CorrectionEntry => ({
    issueId: row.id,
    role,
    from: current.version,
    to: to.version,
    reason,
    evidence: args.evidence,
    by: args.userId,
    at,
  });
  const issueJson = JSON.stringify(row.id);
  await db.transaction(async (tx) => {
    // one correction at a time per issue: a second waits, then finds the first already moved it
    await tx.execute(sql`SELECT 1 FROM ${issues} WHERE ${issues.id} = ${row.id} FOR UPDATE`);
    const moved = await writeRunMetadata(
      from.id,
      {
        value: sql`jsonb_set(jsonb_set(coalesce(metadata, '{}'::jsonb),
          '{rosterSuperseded}',
          coalesce(metadata -> 'rosterSuperseded', '[]'::jsonb) || ${issueJson}::jsonb),
          '{shippedInCorrections}',
          coalesce(metadata -> 'shippedInCorrections', '[]'::jsonb) || ${JSON.stringify([entry('superseded')])}::jsonb)`,
        when: sql`NOT coalesce(metadata -> 'rosterSuperseded', '[]'::jsonb) @> ${issueJson}::jsonb`,
        touch: true,
      },
      tx,
    );
    if (!moved) {
      throw refuseRelease(
        'RELEASE_SHIPPED_IN_CORRECTS_MISMATCH',
        `ISS-${row.issSeq} was moved off ${current.version} by another correction while this one was made; read it again.`,
        correctsPath,
      );
    }
    await writeRunMetadata(
      to.runId,
      {
        value: sql`jsonb_set(jsonb_set(jsonb_set(coalesce(metadata, '{}'::jsonb),
          '{rosterClosed}', (SELECT jsonb_agg(DISTINCT id) FROM jsonb_array_elements_text(
            coalesce(metadata -> 'rosterClosed', '[]'::jsonb) || ${issueJson}::jsonb) AS t(id))),
          '{rosterSuperseded}',
          coalesce(metadata -> 'rosterSuperseded', '[]'::jsonb) - ${row.id}::text),
          '{shippedInCorrections}',
          coalesce(metadata -> 'shippedInCorrections', '[]'::jsonb) || ${JSON.stringify([entry('corrected')])}::jsonb)`,
        touch: true,
      },
      tx,
    );
    await recordActivityTx(tx, {
      issueId: row.id,
      actor: { type: 'user', id: args.userId, agency: 'agent' },
      action: SHIPPED_IN_CORRECTED,
      payload: {
        from: current.version,
        fromRunId: from.id,
        to: to.version,
        toRunId: to.runId,
        reason,
        evidence: args.evidence,
      },
    });
    await postIssueNotice(
      {
        issueId: row.id,
        authorId: args.userId,
        body:
          `Shipped in ${to.version}, corrected from ${current.version} by its agent: ${reason} ` +
          `Evidence: ${args.evidence}. Release ${current.version} no longer lists this issue; the ` +
          `record that named it stays on that release, marked superseded by this one. The issue stays closed.`,
      },
      tx,
    );
  });
  return {
    issueId: row.id,
    version: to.version,
    runId: to.runId,
    closed: true,
    corrected: { version: current.version, runId: from.id },
  };
}

/** The corrections a release run keeps (`metadata.shippedInCorrections`), each one whole. */
export function correctionsIn(metadata: Record<string, unknown>): CorrectionEntry[] {
  const list = metadata.shippedInCorrections;
  if (!Array.isArray(list)) return [];
  return list.filter(
    (e): e is CorrectionEntry =>
      typeof e === 'object' &&
      e !== null &&
      (e.role === 'superseded' || e.role === 'corrected') &&
      ['issueId', 'from', 'to', 'reason', 'evidence', 'by', 'at'].every(
        (k) => typeof (e as Record<string, unknown>)[k] === 'string',
      ),
  );
}

/**
 * The corrections a release keeps, as its read shows them: the issue by key and title, who made
 * each by name, and whether it moved the issue off this release (`out`) or onto it (`in`).
 */
export async function correctionViews(
  projectId: string,
  entries: readonly CorrectionEntry[],
): Promise<ReleaseShippedInCorrection[]> {
  if (entries.length === 0) return [];
  const [named, people] = await Promise.all([
    issueKeysAndTitles(
      projectId,
      entries.map((e) => e.issueId),
    ),
    peopleOf(entries.map((e) => e.by)),
  ]);
  return entries.map((e) => ({
    direction: e.role === 'superseded' ? 'out' : 'in',
    key: named.get(e.issueId)?.key ?? 'unknown issue',
    title: named.get(e.issueId)?.title ?? '',
    from: e.from,
    to: e.to,
    by: {
      id: e.by,
      name: people.get(e.by)?.name ?? 'Unknown',
      kind: people.get(e.by)?.kind ?? 'human',
    },
    at: e.at,
    reason: e.reason,
    evidence: e.evidence,
  }));
}

const idsIn = (list: unknown): string[] =>
  Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : [];
