import { eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issues } from '../db/schema.js';
import { logger } from '../logger.js';
import { indexMemory } from '../memory/indexer.js';
import type { HooksBus } from './hooks.js';

/**
 * ISS-32 — CI fix pattern learning.
 *
 * When an issue successfully traverses `reopen → developed`, capture the
 * (errors, diff) signature on its `sessionContext.ciFixContext` as a memory
 * row tagged `kind:'ci_fix_pattern'`. The query side (ci-fix-pattern-query)
 * later injects matching patterns into forge-code job payloads so the runner
 * can pre-emptively avoid known regressions.
 *
 * Storage piggybacks on the existing `memories` table:
 *   source     = 'note'
 *   sourceRef  = `ci_fix_pattern:<errorTypesKey>:<fileTypesKey>`
 *   metadata   = { kind: 'ci_fix_pattern', errorTypes, fileTypes, diffSummary, branch? }
 *
 * Dedup is automatic via the `memories_project_source_ref_uq` unique index —
 * a second `reopen → developed` with the same error+file signature updates
 * the existing row instead of inserting a duplicate. After upsert we enforce
 * a per-(errorType) cap of `MAX_PATTERNS_PER_ERROR_TYPE` rows by deleting
 * the least-recently-updated entries (see `enforcePatternCap`).
 */

const MAX_DIFF_SUMMARY_CHARS = 1024;
export const MAX_PATTERNS_PER_ERROR_TYPE = 5;

export interface CiFixContextLike {
  errors?: Array<{ type?: string | null; [key: string]: unknown }> | null;
  files?: string[] | null;
  fileTypes?: string[] | null;
  diffSummary?: string | null;
  branch?: string | null;
}

export interface FixPattern {
  errorTypes: string[];
  fileTypes: string[];
  diffSummary: string;
  branch?: string;
}

function fileExt(path: string): string | null {
  const base = path.split('/').pop() ?? '';
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) return null;
  return base.slice(dot + 1).toLowerCase();
}

function uniq(values: string[]): string[] {
  return Array.from(new Set(values.filter((v) => v && v.length > 0))).sort();
}

/**
 * Pure helper. Returns `null` when the context lacks any usable error
 * signature — the caller should treat that as "skip storage" rather than an
 * empty pattern.
 */
export function extractFixPattern(
  ctx: CiFixContextLike | null | undefined,
  diffSummaryOverride?: string | null,
): FixPattern | null {
  if (!ctx) return null;
  const errorTypes = uniq(
    (ctx.errors ?? [])
      .map((e) => (typeof e?.type === 'string' ? e.type : null))
      .filter((v): v is string => v !== null),
  );
  if (errorTypes.length === 0) return null;

  const fileTypesFromList = ctx.fileTypes ?? [];
  const fileTypesFromFiles = (ctx.files ?? [])
    .map((f) => fileExt(f))
    .filter((v): v is string => v !== null);
  const fileTypes = uniq([...fileTypesFromList, ...fileTypesFromFiles]);

  const rawDiff = (diffSummaryOverride ?? ctx.diffSummary ?? '').trim();
  const diffSummary =
    rawDiff.length > MAX_DIFF_SUMMARY_CHARS ? rawDiff.slice(0, MAX_DIFF_SUMMARY_CHARS) : rawDiff;

  const pattern: FixPattern = { errorTypes, fileTypes, diffSummary };
  if (ctx.branch) pattern.branch = ctx.branch;
  return pattern;
}

function sourceRefFor(pattern: FixPattern): string {
  const errKey = pattern.errorTypes.join(',');
  const fileKey = pattern.fileTypes.join(',') || 'any';
  return `ci_fix_pattern:${errKey}:${fileKey}`;
}

/**
 * Upsert a pattern memory and enforce the per-errorType cap. Safe to call
 * concurrently — the upsert relies on the unique index, the cap pass uses a
 * `updated_at`-ordered delete that is idempotent under repetition.
 */
export async function storeCiFixPattern(args: {
  projectId: string;
  pattern: FixPattern;
}): Promise<void> {
  const { projectId, pattern } = args;
  const sourceRef = sourceRefFor(pattern);
  const text = `${pattern.errorTypes.join(' ')}${
    pattern.diffSummary ? ` | ${pattern.diffSummary}` : ''
  }`;

  await indexMemory({
    projectId,
    source: 'note',
    sourceRef,
    text,
    metadata: {
      kind: 'ci_fix_pattern',
      errorTypes: pattern.errorTypes,
      fileTypes: pattern.fileTypes,
      diffSummary: pattern.diffSummary,
      ...(pattern.branch ? { branch: pattern.branch } : {}),
    },
  });

  for (const errorType of pattern.errorTypes) {
    await enforcePatternCap(projectId, errorType);
  }
}

/**
 * Delete the least-recently-updated `ci_fix_pattern` rows for a given
 * errorType once the count exceeds `MAX_PATTERNS_PER_ERROR_TYPE`.
 *
 * Why `updated_at`, not `created_at`: `indexMemory` upserts via
 * `onConflictDoUpdate` and refreshes `updated_at` (and `embedded_at`) on
 * every re-store, while `created_at` is preserved across upserts. Sorting
 * by `created_at` would evict a frequently-updated, high-signal pattern
 * the moment a 6th distinct sibling appears, while a stale row that has
 * never been re-encountered survives. Eviction by `updated_at` keeps the
 * patterns we keep seeing and drops the ones we've stopped seeing.
 *
 * Best-effort cap: two concurrent learners on the same errorType can
 * momentarily leave 6+ rows because each sees a snapshot taken before the
 * other commits. A stray row is harmless (it just falls out on the next
 * insert), so we do not lock or serialise — this is a quality-of-life
 * pruner, not a hard invariant.
 *
 * Multi-errorType skew: a row tagged `errorTypes:['a','b']` counts toward
 * both caps. Eviction is by `updated_at` regardless, so the multi-type row
 * may survive longer than a same-age single-type row simply because its
 * latest upsert was the most recent for both buckets. Acceptable for v1.
 */
export async function enforcePatternCap(projectId: string, errorType: string): Promise<void> {
  const errorTypeJson = JSON.stringify([errorType]);
  // Sort newest-updated-first and skip the freshest MAX rows; the remainder
  // are the stalest extras and get deleted. Using ASC + OFFSET would do the
  // inverse and evict the just-stored row instead.
  await db.execute(sql`
    DELETE FROM memories
    WHERE id IN (
      SELECT id FROM memories
      WHERE project_id = ${projectId}
        AND source = 'note'
        AND metadata->>'kind' = 'ci_fix_pattern'
        AND metadata->'errorTypes' @> ${errorTypeJson}::jsonb
      ORDER BY updated_at DESC
      OFFSET ${MAX_PATTERNS_PER_ERROR_TYPE}
    )
  `);
}

async function loadCiFixContext(issueId: string): Promise<CiFixContextLike | null> {
  const [row] = await db
    .select({ sessionContext: issues.sessionContext })
    .from(issues)
    .where(eq(issues.id, issueId))
    .limit(1);
  if (!row?.sessionContext) return null;
  const ctx = row.sessionContext as { ciFixContext?: CiFixContextLike | null };
  return ctx?.ciFixContext ?? null;
}

let alreadyRegistered = false;

/**
 * Subscribe the pattern learner to the hook bus. Single-registration
 * guarded — boot calls this once; tests that re-import the module get a
 * no-op unsubscribe on the second call (mirrors `registerMemoryIndexer`).
 */
export function registerCiFixPatternLearner(bus: HooksBus): () => void {
  if (alreadyRegistered) return () => undefined;
  alreadyRegistered = true;

  const detach = (fn: () => Promise<void>) =>
    queueMicrotask(() => {
      fn().catch((err) => {
        logger.warn(
          { err: (err as Error).message },
          'ci_fix_pattern.learn: detached task failed',
        );
      });
    });

  const unsub = bus.on('transition', (payload) => {
    // UC-6: only learn from a fix loop (reopen → ... → developed). First-pass
    // developed has no fix context to learn from.
    if (payload.to !== 'developed') return;
    if (payload.reopenCount <= 0) return;

    detach(async () => {
      const ctx = await loadCiFixContext(payload.issueId);
      if (!ctx) return; // Edge: missing ciFixContext → skip silently
      const pattern = extractFixPattern(ctx);
      if (!pattern) return;
      await storeCiFixPattern({ projectId: payload.projectId, pattern });
      logger.info(
        {
          issueId: payload.issueId,
          projectId: payload.projectId,
          errorTypes: pattern.errorTypes,
          fileTypes: pattern.fileTypes,
        },
        'ci_fix_pattern.learn: stored',
      );
    });
  });

  return () => {
    unsub();
    alreadyRegistered = false;
  };
}

/** Test-only. */
export function resetCiFixPatternLearnerRegistration(): void {
  alreadyRegistered = false;
}
