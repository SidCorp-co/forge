import { and, eq, type SQL, sql } from 'drizzle-orm';
import { readThresholds } from '../../admin/thresholds.js';
import { db } from '../../db/client.js';
import { comments, issues, projects } from '../../db/schema.js';
import { transitionIssueStatus } from '../../issues/apply-transition.js';
import { logger } from '../../logger.js';
import { judgeSentryIssue, type SentryAdmissionThresholds } from './admission.js';
import type { SentryIssueDetail } from './types.js';

/** The status a Sentry issue is filed at, and the only one this path ever writes on a create. */
export const SENTRY_FILED_STATUS = 'draft' as const;
/** The `issues.source` value this path writes. */
export const SENTRY_ISSUE_SOURCE = 'sentry' as const;
/**
 * The Sentry substatus that means an error somebody had resolved is happening again.
 *
 * Structural, which is why acting on it does not breach the rule that Sentry text never decides an
 * action: this is an enum Sentry computes, not a string an event carried.
 */
export const SENTRY_REGRESSED_SUBSTATUS = 'regressed';

const TITLE_CAP = 200;

/** What `issues.metadata.sentry` holds, and the only key of that metadata this path writes. */
export interface SentrySightingRecord {
  shortId: string;
  count: number | null;
  userCount: number | null;
  lastSeen: string | null;
  permalink: string | null;
  seenAt: string;
  /** Set where THIS sighting carried no event count and the one above was carried forward. */
  countMissingAt?: string;
  /**
   * The `lastSeen` of the recurrence a reopen was already performed for.
   *
   * The watermark that makes a reopen idempotent per recurrence rather than per delivery. Sentry
   * re-delivers a hook that failed, carrying an identical body — so without this, a regression that
   * reopened an issue somebody then closed again would reopen it a second time off the replay,
   * incrementing the counter and posting a second reason for a recurrence that never happened
   * twice.
   */
  reopenedAtLastSeen?: string;
}

/**
 * The row a filed Sentry issue becomes — a CLOSED shape, and that is the point.
 *
 * There is no `priority`, no `category` and no label here, so no amount of Sentry text can reach
 * one: the columns those would be take their own defaults. `status` is a literal.
 */
export interface SentryIssueRow {
  title: string;
  description: string;
  status: typeof SENTRY_FILED_STATUS;
  source: typeof SENTRY_ISSUE_SOURCE;
  externalId: string;
  detectorKey: string;
}

/** Everything one intake decision needs that is not the Sentry issue itself. */
export interface SentryIntakeContext {
  projectId: string;
  /** The Forge user a filed issue and a reopen are attributed to (`projects.createdBy`). */
  createdById: string;
  thresholds: SentryAdmissionThresholds;
  /** The declared target this issue was confined to, named in the filed issue's body. */
  target: { label: string; organizationSlug: string; projectSlug?: string };
}

/**
 * What one intake decision did, in the vocabulary both doors report in.
 *
 * `refused` carries its own sentence rather than a code: the pull writes it into the schedule run's
 * output and the webhook onto its delivery row, and in both places a person reading it has to be
 * able to fix the cause without opening the source.
 */
export type SentryIntakeOutcome =
  | { kind: 'filed' }
  | { kind: 'commented' }
  | { kind: 'refreshed' }
  | { kind: 'reopened' }
  | { kind: 'refused'; reason: string };

export async function projectCreatedById(projectId: string): Promise<string | null> {
  const [row] = await db
    .select({ createdBy: projects.createdBy })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  return row?.createdBy ?? null;
}

/** The admission policy, read from `admin_thresholds` — the SAME read on both doors. */
export async function readSentryThresholds(): Promise<SentryAdmissionThresholds> {
  const policy = await readThresholds();
  return {
    minEventCount: policy.sentryMinEventCount,
    minUserCount: policy.sentryMinUserCount,
  };
}

/** Bound a TITLE, which is a column a person scans. Never used for the run's own record. */
function capTitle(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * The title and body a Sentry issue becomes.
 *
 * Both fields are already `sanitizeUntrusted`-stripped by `issues.ts:projectIssue`. The title is
 * capped because it is a column a person scans, and the structural fields (counts, timestamps,
 * permalink) are written by this code from typed values rather than copied out of free text.
 */
export function buildSentryIssueRow(
  issue: SentryIssueDetail,
  externalId: string,
  detectorKey: string,
  target: { label: string; organizationSlug: string; projectSlug?: string },
): SentryIssueRow {
  const headline = issue.title?.trim() ? issue.title.trim() : `Sentry issue ${externalId}`;
  const lines = [
    `Filed from Sentry issue \`${externalId}\` on target **${target.label}** (org \`${target.organizationSlug}\`${target.projectSlug ? `, project \`${target.projectSlug}\`` : ''}).`,
    '',
    `- Level: ${issue.level ?? 'unknown'}`,
    `- Events: ${issue.count ?? 'not reported'}`,
    `- Users affected: ${issue.userCount ?? 'not reported'}`,
    `- First seen: ${issue.firstSeen ?? 'not reported'}`,
    `- Last seen: ${issue.lastSeen ?? 'not reported'}`,
    ...(issue.permalink ? [`- Sentry: ${issue.permalink}`] : []),
    '',
    '## Culprit',
    '',
    issue.culprit?.trim() ? issue.culprit : '_Sentry reported none._',
    '',
    '## Message',
    '',
    issue.metadataValue?.trim() ? issue.metadataValue : '_Sentry reported none._',
  ];
  return {
    title: capTitle(headline, TITLE_CAP),
    description: lines.join('\n'),
    status: SENTRY_FILED_STATUS,
    source: SENTRY_ISSUE_SOURCE,
    externalId,
    detectorKey,
  };
}

export function sentryMetadataMerge(record: SentrySightingRecord): SQL {
  return sql`coalesce(${issues.metadata}, '{}'::jsonb) || ${JSON.stringify({ sentry: record })}::jsonb`;
}

export function sentryWatermarkStamp(lastSeen: string): SQL {
  return sql`jsonb_set(
    coalesce(${issues.metadata}, '{}'::jsonb),
    '{sentry}',
    coalesce(${issues.metadata} -> 'sentry', '{}'::jsonb) || ${JSON.stringify({ reopenedAtLastSeen: lastSeen })}::jsonb,
    true
  )`;
}

export function sighting(
  issue: SentryIssueDetail,
  shortId: string,
  previous: SentrySightingRecord | null,
): SentrySightingRecord {
  return {
    shortId,
    count: issue.count ?? previous?.count ?? null,
    userCount: issue.userCount ?? previous?.userCount ?? null,
    lastSeen: issue.lastSeen ?? previous?.lastSeen ?? null,
    permalink: issue.permalink ?? previous?.permalink ?? null,
    seenAt: new Date().toISOString(),
    ...(issue.count === null ? { countMissingAt: new Date().toISOString() } : {}),
    ...(previous?.reopenedAtLastSeen ? { reopenedAtLastSeen: previous.reopenedAtLastSeen } : {}),
  };
}

/** A Sentry timestamp as a comparable instant, or `null` where it is absent or unparseable. */
function parseSeen(value: string | null | undefined): number | null {
  if (!value) return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : t;
}

/** The whole sighting the last observation stored, or `null` where none was ever stored. */
export function recordedSighting(
  metadata: Record<string, unknown> | null,
): SentrySightingRecord | null {
  const entry = (metadata?.sentry ?? null) as SentrySightingRecord | null;
  return entry && typeof entry === 'object' ? entry : null;
}

export function recordedCount(metadata: Record<string, unknown> | null): number | null {
  const entry = (metadata?.sentry ?? null) as { count?: unknown } | null;
  if (!entry || typeof entry.count !== 'number') return null;
  return entry.count;
}

interface ExistingIssue {
  id: string;
  projectId: string;
  status: string;
  reopenCount: number;
  metadata: Record<string, unknown> | null;
}

async function findFiled(projectId: string, externalId: string): Promise<ExistingIssue | null> {
  const [row] = await db
    .select({
      id: issues.id,
      projectId: issues.projectId,
      status: issues.status,
      reopenCount: issues.reopenCount,
      metadata: issues.metadata,
    })
    .from(issues)
    .where(
      and(
        eq(issues.projectId, projectId),
        eq(issues.source, SENTRY_ISSUE_SOURCE),
        eq(issues.externalId, externalId),
      ),
    )
    .limit(1);
  return row
    ? {
        id: row.id,
        projectId: row.projectId,
        status: row.status as string,
        reopenCount: row.reopenCount,
        metadata: (row.metadata ?? null) as Record<string, unknown> | null,
      }
    : null;
}

/**
 * An error that is already work: refresh what we know, and say so ONLY where something moved.
 *
 * A comment on every tick is how an operator-facing signal becomes noise they filter out, so the
 * comment is conditional on the event count having grown. The metadata is written either way —
 * `lastSeen` moving is worth recording and is not worth interrupting anybody for.
 */
interface Observation {
  what: 'commented' | 'refreshed';
  /** The sighting recorded BEFORE this one, read under the same lock the write took. */
  previous: SentrySightingRecord | null;
}

async function observe(
  existing: ExistingIssue,
  issue: SentryIssueDetail,
  shortId: string,
  authorId: string,
): Promise<Observation> {
  return db.transaction(async (tx) => {
    const [locked] = await tx
      .select({ metadata: issues.metadata })
      .from(issues)
      .where(eq(issues.id, existing.id))
      .for('update')
      .limit(1);
    const previous = recordedSighting((locked?.metadata ?? null) as Record<string, unknown> | null);
    const previousCount = previous?.count ?? null;
    const grew = issue.count !== null && previousCount !== null && issue.count > previousCount;

    if (grew) {
      await tx.insert(comments).values({
        issueId: existing.id,
        authorId,
        body: [
          `Sentry has seen \`${shortId}\` again.`,
          '',
          `- Events: ${issue.count} (was ${previousCount})`,
          `- Users affected: ${issue.userCount ?? 'not reported'}`,
          `- Last seen: ${issue.lastSeen ?? 'not reported'}`,
          ...(issue.permalink ? ['', issue.permalink] : []),
        ].join('\n'),
      });
    }

    await tx
      .update(issues)
      .set({ metadata: sentryMetadataMerge(sighting(issue, shortId, previous)) })
      .where(eq(issues.id, existing.id));

    return { what: grew ? 'commented' : 'refreshed', previous };
  });
}

async function file(
  projectId: string,
  createdById: string,
  row: SentryIssueRow,
  baseline: SentrySightingRecord,
): Promise<'filed' | 'raced'> {
  const inserted = await db.execute<{ id: string }>(sql`
    INSERT INTO issues (project_id, title, description, created_by_id, source, external_id, detector_key, status, created_via, metadata)
    VALUES (${projectId}, ${row.title}, ${row.description}, ${createdById}, ${row.source}, ${row.externalId}, ${row.detectorKey}, ${row.status}, 'system', ${JSON.stringify({ sentry: baseline })}::jsonb)
    ON CONFLICT (project_id, source, external_id) WHERE external_id IS NOT NULL DO NOTHING
    RETURNING id
  `);
  return (inserted[0] as { id?: string } | undefined)?.id ? 'filed' : 'raced';
}

/**
 * An error that came back after somebody called it done.
 *
 * Returns `null` where this regression asks for no status move, so the caller falls through to what
 * the observation already decided.
 */
async function reopenOnRegression(
  existing: ExistingIssue,
  issue: SentryIssueDetail,
  shortId: string,
  previous: SentrySightingRecord | null,
  ctx: SentryIntakeContext,
): Promise<SentryIntakeOutcome | null> {
  if (existing.status === 'dropped') {
    return {
      kind: 'refused',
      reason: `Sentry reports ${shortId} has regressed, and the Forge issue holding it stands at \`dropped\` — a person decided not to fix this, so it is left where it is rather than reopened. Its counts were still refreshed.`,
    };
  }
  if (existing.status !== 'closed') return null;

  const recurrence = parseSeen(issue.lastSeen);
  if (recurrence === null) {
    return {
      kind: 'refused',
      reason: `Sentry reports ${shortId} has regressed but timestamps it \`${issue.lastSeen ?? 'not at all'}\`, and a recurrence with no usable time cannot be told apart from one already acted on — this is refused rather than reopened on a guess. The scheduled pull will carry it on the next tick.`,
    };
  }
  const mark = parseSeen(previous?.reopenedAtLastSeen ?? null);
  if (mark !== null && recurrence <= mark) {
    return {
      kind: 'refused',
      reason: `Sentry reports ${shortId} has regressed, but this recurrence (last seen ${issue.lastSeen}) is not newer than the one this issue was already reopened for (${previous?.reopenedAtLastSeen}) — a re-delivered hook, not a second regression, so nothing was moved.`,
    };
  }

  await transitionIssueStatus(
    {
      id: existing.id,
      projectId: existing.projectId,
      status: 'closed',
      reopenCount: existing.reopenCount,
    },
    'reopen',
    // No credential is behind a detector reopen — the Sentry webhook is the
    // writer and `ctx.createdById` only says whose intake configuration it ran
    // under. The audit row names the machine, said here rather than left to a
    // collapse in `actorAgency` (ISS-1137).
    { type: 'user', id: ctx.createdById, agency: 'agent' },
    {
      transitionReason: `Sentry reports ${shortId} has regressed: this error is happening again after this issue was closed. Reopened rather than filed a second time — an error coming back is the same work, and the detector key holds at most one live issue for it.`,
    },
  );

  await db
    .update(issues)
    .set({ metadata: sentryWatermarkStamp(issue.lastSeen as string) })
    .where(eq(issues.id, existing.id));

  logger.info(
    { projectId: ctx.projectId, issueId: existing.id, shortId },
    'sentry intake: regression reopened a closed issue',
  );
  return { kind: 'reopened' };
}

/**
 * ONE Sentry issue, decided. The whole of what a door has to do with an error.
 *
 * Both callers — `intake.ts`'s scheduled pull and `webhook.ts`'s delivery handler — reach this and
 * nothing else, so neither can answer differently about whether an error is work.
 */
export async function intakeSentryIssue(
  issue: SentryIssueDetail,
  ctx: SentryIntakeContext,
): Promise<SentryIntakeOutcome> {
  const shortId = issue.shortId?.trim() ?? '';
  const existing = shortId === '' ? null : await findFiled(ctx.projectId, shortId);
  if (existing) {
    const observed = await observe(existing, issue, shortId, ctx.createdById);
    if (issue.substatus === SENTRY_REGRESSED_SUBSTATUS) {
      const regressed = await reopenOnRegression(existing, issue, shortId, observed.previous, ctx);
      if (regressed) return regressed;
    }
    return observed.what === 'commented' ? { kind: 'commented' } : { kind: 'refreshed' };
  }

  const verdict = judgeSentryIssue(issue, ctx.thresholds);
  if (!verdict.admit) return { kind: 'refused', reason: verdict.reason };

  const outcome = await file(
    ctx.projectId,
    ctx.createdById,
    buildSentryIssueRow(issue, verdict.externalId, verdict.detectorKey, ctx.target),
    sighting(issue, verdict.externalId, null),
  );
  if (outcome === 'filed') return { kind: 'filed' };

  const winner = await findFiled(ctx.projectId, verdict.externalId);
  if (!winner) {
    return {
      kind: 'refused',
      reason: `the insert for ${verdict.externalId} was refused by the unique index and the row it collided with could not be read back`,
    };
  }
  const raced = await observe(winner, issue, verdict.externalId, ctx.createdById);
  return raced.what === 'commented' ? { kind: 'commented' } : { kind: 'refreshed' };
}
