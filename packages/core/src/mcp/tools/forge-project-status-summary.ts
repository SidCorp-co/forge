/**
 * ISS-673 — deterministic project status-summary tool.
 *
 * Root cause this fixes: the chat LLM's only status visibility was
 * `forge_issues.list` (raw per-issue `status`), so the model self-counted and
 * mis-bucketed progress (reported a project as "not started" while dozens of
 * issues were already `closed`). This tool computes the done/in-flight/
 * remaining rollup server-side, live on every call, so the model only
 * formats pre-computed facts — it never classifies status itself.
 */

import { asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { type IssueStatus, issueStatuses, issues } from '../../db/schema.js';
import { getKnowledgeEntry } from '../../knowledge/service.js';
import {
  type ContextScopedMcpToolFactory,
  assertPrincipalIsMember,
  zodToMcpSchema,
} from './lib.js';

// Cap the live scan so a pathologically large project degrades loudly (via
// `truncated: true`) instead of silently dropping rows or ballooning memory.
const STATUS_SUMMARY_ROW_LIMIT = 5000;

const inputSchema = z
  .object({
    projectId: z.uuid(),
    groupByFeature: z.boolean().optional().default(true),
  })
  .strict();

export type StatusBucket = 'done' | 'in_flight' | 'remaining';

// Statuses whose `mergedAt` (if ever set, e.g. by a later-reversed release)
// must NOT count as done — these are explicitly not-finished states.
const MERGED_EXCLUDED_STATUSES = new Set<IssueStatus>(['draft', 'on_hold', 'needs_info', 'reopen']);

const REMAINING_STATUSES = new Set<IssueStatus>(['draft', 'waiting', 'needs_info', 'on_hold']);

/**
 * Single source of truth for the done/in-flight/remaining bucket rule
 * (ISS-673 AC). Order matters:
 *   1. done = status='closed' OR (mergedAt set AND status not in the
 *      merged-excluded set) — covers a reopened/on-hold/draft/needs-info
 *      issue that happens to carry a stale `mergedAt`.
 *   2. remaining = draft/waiting/needs_info/on_hold (not already done).
 *   3. in_flight = everything else.
 */
export function bucketOf(status: IssueStatus, mergedAt: Date | string | null): StatusBucket {
  if (status === 'closed') return 'done';
  if (mergedAt != null && !MERGED_EXCLUDED_STATUSES.has(status)) return 'done';
  if (REMAINING_STATUSES.has(status)) return 'remaining';
  return 'in_flight';
}

export type FeatureMap = Record<string, string[]>;

/** Parse a `feature-map` knowledge entry body: `{ featureName: [pattern, ...] }`. */
export function parseFeatureMapBody(body: string): FeatureMap | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  for (const patterns of Object.values(parsed as Record<string, unknown>)) {
    if (!Array.isArray(patterns) || !patterns.every((p) => typeof p === 'string')) return null;
  }
  return parsed as FeatureMap;
}

// A pattern wrapped as `/…/flags` is treated as a regex; anything else is a
// case-insensitive title-prefix match.
const REGEX_PATTERN_RE = /^\/(.*)\/([a-z]*)$/;

function matchesPattern(title: string, pattern: string): boolean {
  const literal = REGEX_PATTERN_RE.exec(pattern);
  if (literal) {
    try {
      return new RegExp(literal[1] ?? '', literal[2] ?? '').test(title);
    } catch {
      return false;
    }
  }
  return title.toLowerCase().startsWith(pattern.toLowerCase());
}

// Fallback grouping when no feature-map exists: pull a leading `[Tag]` or
// `Tag:` token off the title.
const TITLE_PREFIX_RE = /^\s*(?:\[([^\]]{1,40})\]|([A-Za-z][A-Za-z0-9_-]{1,24}):)/;

/** Assign one issue to a feature group. Never returns an empty string — falls back to "Other". */
export function assignFeature(title: string, featureMap: FeatureMap | null): string {
  if (featureMap) {
    for (const [name, patterns] of Object.entries(featureMap)) {
      if (patterns.some((p) => matchesPattern(title, p))) return name;
    }
  }
  const match = TITLE_PREFIX_RE.exec(title);
  const prefix = match?.[1] ?? match?.[2];
  return prefix ? prefix.trim() : 'Other';
}

type FeatureCounts = { done: number; inFlight: number; remaining: number; total: number };

export const forgeProjectStatusSummaryTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_project_status_summary',
  description:
    "Deterministic, live-queried (no cache) project progress summary — the authoritative source for ANY question about project progress, how far along work is, or a status breakdown. Bucket rule, computed server-side (do NOT recount or reclassify issues yourself): done = status='closed' OR (mergedAt is set AND status is not one of draft/on_hold/needs_info/reopen); remaining = draft/waiting/needs_info/on_hold (not yet started / parked); in_flight = everything else (open, confirmed, clarified, approved, in_progress, developed, testing, tested, released, reopen). Closed and merged issues ARE completed work and MUST be counted as done — never report a project as untouched when it has done > 0. Also groups issues by feature on a best-effort basis (a 'feature-map' knowledge entry, else a title-prefix heuristic, else a single 'Other' group) — every issue is counted exactly once, so sum(features[].total) === overall.total. An empty project or a DB read failure returns an explicit fact (empty:true or status:'unavailable') — never silently omit or guess. Returns `{ ok, empty?, overall:{done,inFlight,remaining,total}, byStatus, features?, truncated?, message? }`.",
  inputSchema: zodToMcpSchema(inputSchema),
  handler: async (args) => {
    const input = inputSchema.parse(args);
    await assertPrincipalIsMember(ctx.principal, input.projectId);

    let rows: Array<{ id: string; title: string; status: IssueStatus; mergedAt: Date | null }>;
    try {
      rows = await db
        .select({
          id: issues.id,
          title: issues.title,
          status: issues.status,
          mergedAt: issues.mergedAt,
        })
        .from(issues)
        .where(eq(issues.projectId, input.projectId))
        .orderBy(asc(issues.createdAt))
        .limit(STATUS_SUMMARY_ROW_LIMIT + 1);
    } catch {
      return {
        ok: false,
        status: 'unavailable',
        message: 'Could not read project status right now.',
      };
    }

    const truncated = rows.length > STATUS_SUMMARY_ROW_LIMIT;
    if (truncated) rows = rows.slice(0, STATUS_SUMMARY_ROW_LIMIT);

    const byStatus = Object.fromEntries(issueStatuses.map((s) => [s, 0])) as Record<
      IssueStatus,
      number
    >;

    if (rows.length === 0) {
      return {
        ok: true,
        empty: true,
        overall: { done: 0, inFlight: 0, remaining: 0, total: 0 },
        byStatus,
        message: 'No issues in this project yet.',
      };
    }

    let featureMap: FeatureMap | null = null;
    if (input.groupByFeature) {
      const entry = await getKnowledgeEntry(input.projectId, 'feature-map');
      if (entry && !entry.archivedAt) {
        featureMap = parseFeatureMapBody(entry.body);
      }
    }

    let done = 0;
    let inFlight = 0;
    let remaining = 0;
    const features = new Map<string, FeatureCounts>();

    for (const row of rows) {
      byStatus[row.status] += 1;
      const bucket = bucketOf(row.status, row.mergedAt);
      if (bucket === 'done') done += 1;
      else if (bucket === 'in_flight') inFlight += 1;
      else remaining += 1;

      if (input.groupByFeature) {
        const name = assignFeature(row.title, featureMap);
        const counts = features.get(name) ?? { done: 0, inFlight: 0, remaining: 0, total: 0 };
        counts.total += 1;
        if (bucket === 'done') counts.done += 1;
        else if (bucket === 'in_flight') counts.inFlight += 1;
        else counts.remaining += 1;
        features.set(name, counts);
      }
    }

    const result: Record<string, unknown> = {
      ok: true,
      empty: false,
      overall: { done, inFlight, remaining, total: rows.length },
      byStatus,
    };
    if (truncated) result.truncated = true;
    if (input.groupByFeature) {
      result.features = Array.from(features.entries()).map(([name, counts]) => ({
        name,
        ...counts,
      }));
    }
    return result;
  },
});
