// cm:hack forge-plugin 3.36.542's seventeen statuses, mapped once into the ten (ISS-54): a write
// naming a retired one is answered with a warning; a personal-token read gets back the rung it wrote.
// Exit: when forge-plugin moves to the 10-status model (plugin-followups.md) — this module,
// `issue_work_state.legacy_status` and `issue_session_context()` are deleted together.

import { type SQL, sql } from 'drizzle-orm';
import { type IssueStatus, issueStatuses } from '../db/schema.js';
import type { WorkStep } from '../db/schema-issue-work-state.js';

export const LEGACY_STATUSES = [
  'confirmed',
  'clarified',
  'waiting',
  'developed',
  'testing',
  'tested',
  'releasing',
] as const;
export type LegacyStatus = (typeof LEGACY_STATUSES)[number];

export type LegacyRung = Exclude<LegacyStatus, 'waiting'>;

/** A retired name as the new model holds it: the status it is stored as, and the step inside it. */
export interface LegacyTarget {
  status: IssueStatus;
  step: WorkStep | null;
  rung: LegacyRung | null;
}

// `waiting` keeps no rung: the plugin reads `waiting` and `needs_info` as one landing.
export const LEGACY_TARGETS: Readonly<Record<LegacyStatus, LegacyTarget>> = {
  confirmed: { status: 'in_progress', step: 'plan', rung: 'confirmed' },
  clarified: { status: 'in_progress', step: 'plan', rung: 'clarified' },
  developed: { status: 'in_progress', step: 'test', rung: 'developed' },
  testing: { status: 'in_progress', step: 'test', rung: 'testing' },
  tested: { status: 'awaiting_release', step: null, rung: 'tested' },
  releasing: { status: 'awaiting_release', step: 'release', rung: 'releasing' },
  waiting: { status: 'needs_info', step: null, rung: null },
};

/** What migration 0346 made of a row RESTING at a retired name (a resting `confirmed` has no holder,
 *  so it is `open`): how a retired name read out of stored history resolves. */
export const MIGRATED_AS: Readonly<Record<LegacyStatus, IssueStatus>> = {
  confirmed: 'open',
  clarified: 'open',
  developed: 'in_progress',
  testing: 'in_progress',
  tested: 'awaiting_release',
  releasing: 'awaiting_release',
  waiting: 'needs_info',
};

export function isLegacyStatus(value: string): value is LegacyStatus {
  return (LEGACY_STATUSES as readonly string[]).includes(value);
}

export interface ResolvedStatus {
  status: IssueStatus;
  legacy: (LegacyTarget & { named: LegacyStatus }) | null;
}

export function resolveStatusInput(named: IssueStatus | LegacyStatus): ResolvedStatus {
  if (!isLegacyStatus(named)) return { status: named, legacy: null };
  const target = LEGACY_TARGETS[named];
  return { status: target.status, legacy: { ...target, named } };
}

export function legacyWarning(named: LegacyStatus): string {
  const target = LEGACY_TARGETS[named];
  const step = target.step ? ` at step \`${target.step}\`` : '';
  return `STATUS_RETIRED: \`${named}\` is retired (ISS-54, workflow issue-lifecycle); it was stored as \`${target.status}\`${step}. A client on the ten-status model names \`${target.status}\`, and writes the step through \`workState\`.`;
}

/** How MCP, which never spoke the seventeen, refuses a retired name: what it became, how to say it. */
export function legacyRefusal(named: LegacyStatus): string {
  const target = LEGACY_TARGETS[named];
  const step = target.step ? ` and write \`workState.step: ${target.step}\`` : '';
  const kind = named === 'waiting' ? ' with a `waitingKind`' : '';
  return `STATUS_RETIRED: \`${named}\` is retired (ISS-54, workflow issue-lifecycle). Name \`${target.status}\`${kind}${step}.`;
}

export const STATUS_COMPAT_HEADER = 'X-Forge-Status-Compat';

/** Sent by a ten-status client, answered in the ten whatever its credential; a PAT without it is the plugin. */
export const LIFECYCLE_HEADER = 'X-Forge-Lifecycle';
export const LIFECYCLE_TEN = '10';

export function readsLegacyStatuses(args: {
  principal: 'user' | 'device' | 'pat' | undefined;
  lifecycleHeader: string | undefined;
}): boolean {
  return args.principal === 'pat' && args.lifecycleHeader?.trim() !== LIFECYCLE_TEN;
}

/** The rung a row holds, or null where its stored status has moved off that rung. */
export function heldRung(status: IssueStatus, legacyStatus: string | null): LegacyRung | null {
  if (legacyStatus === null || !isLegacyStatus(legacyStatus)) return null;
  const target = LEGACY_TARGETS[legacyStatus];
  return target.status === status ? target.rung : null;
}

export function readerOnSeventeen(c: {
  get(key: 'principal'): 'user' | 'device' | 'pat' | undefined;
  req: { header(name: string): string | undefined };
}): boolean {
  return readsLegacyStatuses({
    principal: c.get('principal'),
    lifecycleHeader: c.req.header(LIFECYCLE_HEADER),
  });
}

/** What an old-model reader sees: the retired name it wrote, else the stored name (which it also knows). */
export function legacyReadStatus(status: IssueStatus, legacyStatus: string | null): string {
  if (legacyStatus === null || !isLegacyStatus(legacyStatus)) return status;
  return LEGACY_TARGETS[legacyStatus].status === status ? legacyStatus : status;
}

/** A reply row as `readerOnSeventeen` decides it is shown. */
export function issueForReader<
  T extends { status: IssueStatus; workState?: { legacyStatus: string | null } | null },
>(row: T, client17: boolean): Omit<T, 'status'> & { status: string } {
  if (!client17) return row;
  return { ...row, status: legacyReadStatus(row.status, row.workState?.legacyStatus ?? null) };
}

/** Every name a status filter or a move accepts while the amnesty stands: the ten and the seven. */
export const ACCEPTED_STATUS_NAMES = [...issueStatuses, ...LEGACY_STATUSES] as const;
export type AcceptedStatusName = (typeof ACCEPTED_STATUS_NAMES)[number];

function rungsHeldAt(status: IssueStatus): LegacyRung[] {
  return (Object.keys(LEGACY_TARGETS) as LegacyStatus[]).filter(
    (name): name is LegacyRung => name !== 'waiting' && LEGACY_TARGETS[name].status === status,
  );
}

const legacyStatusOfRow = sql`(SELECT w.legacy_status FROM issue_work_state w WHERE w.issue_id = "issues"."id")`;

/** The rows a status filter names, matched the way `issueForReader` shows them; `waiting` matches
 *  the parks it became (`needs_info` on a decision or a resource), since no reply shows it now. */
export function statusFilterSql(named: AcceptedStatusName, client17: boolean): SQL {
  if (named === 'waiting') {
    return sql`("issues"."status" = 'needs_info' AND "issues"."waiting_kind" IN ('needs_decision', 'needs_resource'))`;
  }
  if (isLegacyStatus(named)) {
    const target = LEGACY_TARGETS[named];
    return sql`("issues"."status" = ${target.status} AND ${legacyStatusOfRow} = ${named})`;
  }
  const rungs = rungsHeldAt(named);
  if (!client17 || rungs.length === 0) return sql`("issues"."status" = ${named})`;
  return sql`("issues"."status" = ${named} AND coalesce(${legacyStatusOfRow}, '') <> ALL(${sql.raw(`ARRAY['${rungs.join("','")}']::text[]`)}))`;
}

export function anyStatusFilterSql(names: readonly AcceptedStatusName[], client17: boolean): SQL {
  return sql`(${sql.join(
    names.map((n) => statusFilterSql(n, client17)),
    sql` OR `,
  )})`;
}

/** The warnings a filter naming retired statuses is answered with, one per retired name. */
export function legacyFilterWarnings(names: readonly AcceptedStatusName[]): string[] {
  return [...new Set(names.filter(isLegacyStatus))].map(
    (named) =>
      `STATUS_RETIRED: \`${named}\` is retired (ISS-54, workflow issue-lifecycle); the filter matched the rows a seventeen-status reader is shown at it.`,
  );
}
