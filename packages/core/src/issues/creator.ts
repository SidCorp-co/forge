import { and, inArray, isNotNull, isNull, notInArray, or, type SQL, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issues, users } from '../db/schema.js';
import type { ActorAgency } from './actor-agency.js';

export const FORGE_AGENT_LABEL = 'Forge Agent';

/**
 * The pre-column FLOOR, and only that (ISS-1093).
 *
 * `created_via` names the transport and every door stamps it as a constant, so it
 * cannot answer who was at the keyboard: an agent holding a person's PAT files
 * through REST and lands `web`. It stays here because rows written before
 * `creator_agency` existed have nothing else, and because `buildOriginCondition`
 * below reads the same column for a different question.
 */
export function isAgentChannel(createdVia: string | null): boolean {
  return createdVia != null && createdVia !== 'web';
}

export interface CreatorAgencyRow {
  createdVia: string | null;
  creatorAgency: ActorAgency | null;
}

/**
 * Was this issue filed by an agent? Asked of the credential first.
 */
// cm:guard NOT an OR, and this is the one line where copying `activity-routes.ts:isAgentForRow` breaks the fix. That reader ORs because `activity_log.actor_agency` DEFAULTs to 'human' over every pre-0193 row, so its column can only ever ADD agents. `issues.creator_agency` has no DEFAULT and no such history, so NULL means "no evidence" and a stored value is the answer — including a stored 'human', which an OR would silently discard. Replace this with `=== 'agent' || isAgentChannel(...)` and criteria 9 and 10 go red naming exactly that.
// cm:edge contract -> packages/web-v2/src/features/issues/derive.ts — creatorLabelOf mirrors this rule
export function creatorIsAgent(row: CreatorAgencyRow): boolean {
  if (row.creatorAgency != null) return row.creatorAgency === 'agent';
  return isAgentChannel(row.createdVia);
}

/**
 * `detector_key` is the PRIMARY signal for detector output: a row carrying one
 * was written by a sweep, by construction.
 *
 * `created_via` alone is NOT sufficient and must never be the only test. A
 * scheduled agent that creates through MCP records `mcp`, identical to an
 * operator's own CLI session — measured on forge-dev 2026-08-07, every one of
 * its scheduled-sweep drafts was `mcp` or NULL and not a single one was
 * `schedule`. These channels stay in the predicate only to catch server-side
 * writers that never pass a key.
 */
// cm:guard both halves must stay complementary — a row matching neither (or both) vanishes from the UI or shows twice. Change buildOriginCondition's two branches together.
export const DETECTOR_CHANNELS = ['system', 'schedule'] as const;

export function isDetectorChannel(createdVia: string | null): boolean {
  return createdVia != null && (DETECTOR_CHANNELS as readonly string[]).includes(createdVia);
}

// cm:edge contract -> packages/web-v2/src/features/issues/derive.ts — the Backlog/Findings split mirrors this predicate
export function buildOriginCondition(origin: 'detector' | 'human'): SQL {
  const channels = [...DETECTOR_CHANNELS];
  const viaDetectorChannel = inArray(issues.createdVia, channels);
  if (origin === 'detector') {
    return or(isNotNull(issues.detectorKey), viaDetectorChannel) as SQL;
  }
  // cm:why legacy rows predate created_via and are human backlog, so NULL lands in this branch
  return and(
    isNull(issues.detectorKey),
    or(isNull(issues.createdVia), notInArray(issues.createdVia, channels)),
  ) as SQL;
}

export interface IssueCreator {
  creatorEmail: string | null;
  creatorIsAgent: boolean;
  creatorLabel: string;
}

/**
 * ISS-756 — one grouped query per page, mirrors `sumCostByIssue`'s shape.
 * NEVER falls back to a raw id slice (unlike web-v2 `memberLabel()`) — a
 * creator need not be a project member, so email-or-agent-label is the floor.
 */
export async function hydrateCreatorsForIssues(
  rows: ({ id: string; createdById: string } & CreatorAgencyRow)[],
): Promise<Map<string, IssueCreator>> {
  if (rows.length === 0) return new Map();
  const createdByIds = [...new Set(rows.map((r) => r.createdById))];
  const emailRows = await db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(inArray(users.id, createdByIds));
  const emailById = new Map(emailRows.map((u) => [u.id, u.email]));
  return new Map(
    rows.map((r) => {
      const isAgent = creatorIsAgent(r);
      return [
        r.id,
        {
          creatorEmail: emailById.get(r.createdById) ?? null,
          creatorIsAgent: isAgent,
          creatorLabel: isAgent
            ? FORGE_AGENT_LABEL
            : (emailById.get(r.createdById) ?? 'Unknown user'),
        },
      ];
    }),
  );
}

// cm:guard the SQL twin of `creatorIsAgent` and it must stay its exact mirror: the label and the filter are read together by one person on one screen, so a row the list marks as an agent's and this predicate misses reads as the filter being broken. Both halves move in one edit or neither does.
// cm:edge contract -> packages/core/src/me/attention-buckets.ts — the unseen-draft bucket scopes to agent-filed issues with THIS predicate, and it decides whose inbox a draft lands in. Widening it to match a human-channel row nags a person about a draft they typed themselves; narrowing it drops an agent's draft back to being reachable from nowhere.
// cm:guard the OUTER parentheses are load-bearing and not style. This fragment is spliced raw into
// whatever its caller is building, and its top level is an `OR` — unparenthesised, a caller writing
// `and(status, creatorIsAgentCondition())` gets `status AND a = 'agent' OR (...)`, which `AND`'s
// tighter binding turns into a filter that also returns every agent-filed row of every other status.
// The predicate it replaced was an `AND` chain and needed none, which is exactly why this is easy to
// drop while copying.
// cm:guard the `IS TRUE` makes this TWO-valued, and that is the whole of what it is for. Without it
// a pre-column row — `creator_agency` NULL with `created_via` `web` or NULL, which is every row a
// webhook wrote and every row older than this column — evaluates to SQL NULL rather than false, so
// `NOT (...)` is NULL too and the row falls out of BOTH filters while the list happily labels it
// with its creator's address. `creatorIsAgent` is total in TypeScript and this must be its exact
// mirror in SQL; three-valued logic is the one way they can disagree without either one looking
// wrong (ISS-1093, review finding F1).
export function creatorIsAgentCondition(): SQL {
  return sql`((${issues.creatorAgency} = 'agent' OR (${issues.creatorAgency} IS NULL AND ${issues.createdVia} IS NOT NULL AND ${issues.createdVia} <> 'web')) IS TRUE)`;
}

/**
 * ISS-756 — `createdBy` search predicate. `value === 'agent'` returns every row
 * the list marks as an agent's. A person's uuid EXCLUDES those rows even when
 * `created_by_id` is theirs — a row an agent filed on their credential displays
 * as Forge Agent, so filtering by that person must not surface it. The
 * exclusion is written as the negation of the very predicate the label is read
 * from (ISS-1093), rather than as a second spelling of it, because two
 * spellings is how display and filter drifted apart in the first place.
 */
export function buildCreatedByCondition(value: string): SQL {
  if (value === 'agent') return creatorIsAgentCondition();
  return sql`${issues.createdById} = ${value} AND NOT (${creatorIsAgentCondition()})`;
}
