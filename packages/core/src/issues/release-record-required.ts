import { inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type IssueStatus, issues } from '../db/schema.js';
import { type ActorAgency, actorAgency } from './actor-agency.js';

export interface ReleaseRecordRefusal {
  detail: string;
  details: Record<string, unknown>;
}

export const RELEASE_RECORD_REMEDY =
  'Set `releaseNotes` first: `{ section, userFacing }` with the one plain-language line a ' +
  "user would read, or `{ section: 'Skip', userFacing: '-' }` when the change has no " +
  'user-facing half.';

/**
 * Which of these issues have no release note. The shared read behind both doors.
 */
export async function issuesMissingReleaseRecord(issueIds: string[]): Promise<string[]> {
  if (issueIds.length === 0) return [];
  const rows = await db
    .select({ id: issues.id, releaseNotes: issues.releaseNotes })
    .from(issues)
    .where(inArray(issues.id, issueIds))
    .limit(issueIds.length);
  return rows.filter((r) => !r.releaseNotes).map((r) => r.id);
}

export async function refuseUnrecordedClose(
  issueId: string,
  toStatus: IssueStatus,
  actor: { type: 'user' | 'device'; agency?: ActorAgency | undefined },
  options: { viaReleasePath?: boolean },
): Promise<ReleaseRecordRefusal | null> {
  if (toStatus !== 'closed') return null;
  if (actorAgency(actor) !== 'agent') return null;
  if (options.viaReleasePath === true) return null;

  const missing = await issuesMissingReleaseRecord([issueId]);
  if (missing.length === 0) return null;

  return {
    detail:
      '`closed` is what every reader takes as "this shipped", so an issue cannot close with ' +
      `nothing written about what shipped. ${RELEASE_RECORD_REMEDY} ` +
      'Use `dropped` instead if this turned out not to be work — that closes it without the claim.',
    details: { requires: 'releaseNotes' },
  };
}
