import crypto from 'node:crypto';
import { and, desc, eq, gte, inArray, isNull, lte, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { activityLog, comments, issues, memories, projects } from '../db/schema.js';
import { EmbeddingUnavailableError, embed } from '../embeddings/index.js';
import { resolveMergeStates } from '../issues/merged-at.js';
import { logger } from '../logger.js';
import type { HooksBus } from '../pipeline/hooks.js';
import { boss } from '../queue/boss.js';
import { runMemoryFeedback } from './feedback-service.js';
import { MAX_EMBED_CHARS, indexMemory, indexMemoryBestEffort } from './indexer.js';
import { callFastModel, fastModelConfigured } from './llm.js';
import { type MemoryHit, searchMemories } from './search.js';

/**
 * memory-v2 phase 4 — nightly consolidation, the adapted port of
 * forge-agents' "dream" (`services/memory-dream/`). Differences, per the
 * proposal's deliberate non-goals:
 *
 *  - ARCHIVE replaces PRUNE: the LLM can hide rows (`archived_at`), never
 *    hard-delete them. A later write to the same key revives the row, and
 *    the decay job purges archives only after a 90-day grace period.
 *  - PROMOTE is dropped — no role hierarchy in forge.
 *  - pg-boss schedule instead of a setInterval poller. Runs at 03:00, before
 *    the 03:30 decay sweep, so freshly-merged rows are not double-processed.
 *
 * Signal (last 24h, per project): pipeline comments, status changes, and
 * reopen cycles — the highest-value learning signal (a reopen means the fix
 * or review was wrong). Same caps as the predecessor.
 */

export const MEMORY_CONSOLIDATION_QUEUE = 'memory-consolidation';

export const MAX_CREATES = 5;
export const MAX_UPDATES = 5;
export const MAX_ARCHIVES = 10;
const MAX_MEMORIES_FOR_PROMPT = 200;
const MAX_SIGNAL_COMMENTS = 100;
const MAX_SIGNAL_STATUS_CHANGES = 200;
const SIGNAL_WINDOW_MS = 24 * 60 * 60 * 1000;
const CONSOLIDATABLE_SOURCES = ['note', 'knowledge'] as const;

// ── Promotion constants ───────────────────────────────────────────────────────
// Memories satisfying these thresholds are candidates for promotion to curated
// knowledge_entries via a human/PM gate (DRAFT issue). Nothing auto-promotes.
export const PROMOTION_RETRIEVAL_MIN = 3;
export const PROMOTION_AGE_DAYS = 7;
export const PROMOTION_CANDIDATES_PER_RUN = 3;
const PROMOTABLE_SOURCES = ['knowledge', 'decision'] as const;

// Concurrency guard — prevents overlapping runs for one project (scheduled
// sweep racing a manual trigger).
const runningProjects = new Set<string>();

/**
 * AC3 (ISS-568): propose durable memory lessons for promotion into curated
 * knowledge_entries via a human/PM gate.
 *
 * Selects memories that are:
 *   - source IN ('knowledge', 'decision')
 *   - not archived
 *   - retrieved ≥ PROMOTION_RETRIEVAL_MIN times (durable — actually referenced)
 *   - at least PROMOTION_AGE_DAYS old (not brand-new)
 *   - not already proposed (metadata.promotionProposedAt is NULL)
 *
 * For each candidate, creates ONE DRAFT issue (never 'open') proposing the
 * lesson as a knowledge entry (kind='guide'|'rule', injection='on_demand').
 * Then stamps metadata.promotionProposedAt to prevent re-proposals.
 *
 * HARD RULES:
 *  - NEVER writes knowledge_entries.
 *  - NEVER sets injection='always'.
 *  - Draft issues only — never 'open' (which auto-triages).
 *  - Best-effort: any error is logged, never breaks consolidation.
 */
export async function proposeKnowledgePromotions(projectId: string): Promise<void> {
  const [projectRow] = await db
    .select({ createdBy: projects.createdBy })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!projectRow?.createdBy) {
    logger.debug(
      { projectId },
      'memory.consolidation: proposeKnowledgePromotions: project not found or no creator',
    );
    return;
  }

  const ageThreshold = new Date(Date.now() - PROMOTION_AGE_DAYS * 24 * 60 * 60 * 1000);

  const candidates = await db
    .select({
      id: memories.id,
      source: memories.source,
      sourceRef: memories.sourceRef,
      textContent: memories.textContent,
      metadata: memories.metadata,
    })
    .from(memories)
    .where(
      and(
        eq(memories.projectId, projectId),
        inArray(memories.source, [...PROMOTABLE_SOURCES]),
        isNull(memories.archivedAt),
        gte(memories.retrievalCount, PROMOTION_RETRIEVAL_MIN),
        lte(memories.createdAt, ageThreshold),
        sql`${memories.metadata}->>'promotionProposedAt' IS NULL`,
      ),
    )
    .limit(PROMOTION_CANDIDATES_PER_RUN);

  if (candidates.length === 0) return;

  for (const candidate of candidates) {
    const issueTitle = `Promote memory to knowledge: ${candidate.sourceRef}`;
    const issueDescription = [
      '## Promotion proposal',
      '',
      `**Memory source:** \`${candidate.source}\``,
      `**Source ref:** \`${candidate.sourceRef}\``,
      '',
      '### Lesson',
      '',
      candidate.textContent,
      '',
      '### Proposed knowledge entry',
      '',
      '- **kind:** `guide` or `rule` (reviewer decides)',
      '- **injection:** `on_demand` (NEVER `always`)',
      '- **body:** the lesson text above, refined as appropriate',
      '',
      '*Created automatically by the nightly memory consolidation job. A human/PM gate is required before promoting to curated knowledge.*',
    ].join('\n');

    const [inserted] = await db
      .insert(issues)
      .values({
        projectId,
        title: issueTitle,
        description: issueDescription,
        status: 'draft',
        priority: 'low',
        category: 'knowledge-promotion',
        createdById: projectRow.createdBy,
      })
      .returning({ id: issues.id });

    if (!inserted) {
      logger.warn(
        { projectId, sourceRef: candidate.sourceRef },
        'memory.consolidation: promotion draft insert returned no row',
      );
      continue;
    }

    // Stamp idempotency flag: next run skips this memory.
    await indexMemory({
      projectId,
      source: candidate.source as (typeof PROMOTABLE_SOURCES)[number],
      sourceRef: candidate.sourceRef,
      text: candidate.textContent,
      metadata: {
        ...((candidate.metadata ?? {}) as Record<string, unknown>),
        promotionProposedAt: ageThreshold.toISOString(),
      },
    });

    logger.info(
      { projectId, sourceRef: candidate.sourceRef, issueId: inserted.id },
      'memory.consolidation: promotion draft issue created',
    );
  }
}

const CONSOLIDATION_PROMPT = `You are a memory consolidation agent for a software project management AI pipeline.

## Your Task
Review existing memories and recent pipeline activity, then output consolidation actions.

## Current Memories
{memories}

## Recent Agent Comments (last 24h)
{recent_comments}

## Recent Status Changes (last 24h)
{status_changes}

## Reopen Cycles (pipeline failures — highest-value signal)
{reopen_cycles}

## Actions You Can Take

1. **CREATE** — New reusable pattern discovered from the activity that existing memories do not capture.
   - Only create if genuinely new and reusable across future issues.
   - Categories: preference, correction, convention, tool_pattern

2. **UPDATE** — Merge duplicate/overlapping memories into one cleaner version.
   - Use when two memories say the same thing differently.
   - Keep the most specific, actionable version.

3. **ARCHIVE** — Hide memories that are:
   - About specific closed issues (not reusable patterns)
   - Contradicted by newer information
   - One-time fixes with no reusable insight
   - Duplicates of another memory (after merging via UPDATE)

4. **SKIP** — If nothing qualifies, return empty arrays.

## Rules
- Max ${MAX_CREATES} creates, ${MAX_UPDATES} updates, ${MAX_ARCHIVES} archives per run.
- Preserve the original language (Vietnamese facts stay Vietnamese).
- Convert relative dates to absolute.
- Be conservative — only act when the signal is clear.

## Output JSON only (no markdown, no explanation):
{
  "create": [{ "content": "...", "category": "preference|correction|convention|tool_pattern" }],
  "update": [{ "id": "<memory id>", "newContent": "..." }],
  "archive": ["<memory id>", "..."],
  "summary": "one-line summary of what changed"
}`;

interface ConsolidationActions {
  create?: Array<{ content?: unknown; category?: unknown }>;
  update?: Array<{ id?: unknown; newContent?: unknown }>;
  archive?: unknown[];
  summary?: unknown;
}

export interface ConsolidationResult {
  created: number;
  updated: number;
  archived: number;
  summary: string;
  skipped?: 'disabled' | 'running' | 'no-signal' | 'llm-failed' | 'parse-failed';
}

const VALID_CATEGORIES = new Set(['preference', 'correction', 'convention', 'tool_pattern']);

function emptyResult(
  skipped: NonNullable<ConsolidationResult['skipped']>,
  summary: string,
): ConsolidationResult {
  return { created: 0, updated: 0, archived: 0, summary, skipped };
}

export async function runConsolidationForProject(projectId: string): Promise<ConsolidationResult> {
  if (!fastModelConfigured()) return emptyResult('disabled', 'LLM not configured');
  if (runningProjects.has(projectId)) {
    return emptyResult('running', 'consolidation already running for this project');
  }
  runningProjects.add(projectId);
  try {
    return await consolidate(projectId);
  } finally {
    runningProjects.delete(projectId);
  }
}

async function consolidate(projectId: string): Promise<ConsolidationResult> {
  const since = new Date(Date.now() - SIGNAL_WINDOW_MS);

  // --- Signal: comments, status changes, reopen cycles -----------------
  const recentComments = await db
    .select({ body: comments.body, issueTitle: issues.title })
    .from(comments)
    .innerJoin(issues, eq(comments.issueId, issues.id))
    .where(and(eq(issues.projectId, projectId), gte(comments.createdAt, since)))
    .orderBy(desc(comments.createdAt))
    .limit(MAX_SIGNAL_COMMENTS);

  const statusChanges = await db
    .select({ payload: activityLog.payload, issueTitle: issues.title })
    .from(activityLog)
    .innerJoin(issues, eq(activityLog.issueId, issues.id))
    .where(
      and(
        eq(issues.projectId, projectId),
        eq(activityLog.action, 'issue.statusChanged'),
        gte(activityLog.createdAt, since),
      ),
    )
    .orderBy(desc(activityLog.createdAt))
    .limit(MAX_SIGNAL_STATUS_CHANGES);

  if (recentComments.length === 0 && statusChanges.length === 0) {
    return emptyResult('no-signal', 'no recent signal to consolidate');
  }

  const changes = statusChanges.map((sc) => {
    const p = (sc.payload ?? {}) as { from?: string; to?: string };
    return { issueTitle: sc.issueTitle, from: p.from ?? '', to: p.to ?? '' };
  });
  const reopens = changes.filter((c) => c.to === 'reopen');

  // --- Current memories (agent-curated only) ----------------------------
  const memoryRows = await db
    .select({
      id: memories.id,
      source: memories.source,
      sourceRef: memories.sourceRef,
      textContent: memories.textContent,
      metadata: memories.metadata,
      retrievalCount: memories.retrievalCount,
    })
    .from(memories)
    .where(
      and(
        eq(memories.projectId, projectId),
        inArray(memories.source, [...CONSOLIDATABLE_SOURCES]),
        isNull(memories.archivedAt),
      ),
    )
    .orderBy(desc(memories.updatedAt))
    .limit(MAX_MEMORIES_FOR_PROMPT);
  const byId = new Map(memoryRows.map((m) => [m.id, m]));

  // --- Prompt + LLM ------------------------------------------------------
  const memoriesStr =
    memoryRows.length > 0
      ? memoryRows
          .map(
            (m) =>
              `- [${m.id}] [${m.source}] ${m.textContent.slice(0, 300)} (retrievals: ${m.retrievalCount})`,
          )
          .join('\n')
      : 'None';
  const commentsStr =
    recentComments.length > 0
      ? recentComments.map((c) => `- ${c.issueTitle}: ${c.body.slice(0, 400)}`).join('\n')
      : 'None';
  const statusStr =
    changes.length > 0
      ? changes.map((c) => `- ${c.issueTitle}: ${c.from} -> ${c.to}`).join('\n')
      : 'None';
  const reopenStr =
    reopens.length > 0 ? reopens.map((r) => `- ${r.issueTitle}`).join('\n') : 'None';

  const prompt = CONSOLIDATION_PROMPT.replace('{memories}', memoriesStr)
    .replace('{recent_comments}', commentsStr)
    .replace('{status_changes}', statusStr)
    .replace('{reopen_cycles}', reopenStr);

  const raw = await callFastModel(prompt, 2000);
  if (!raw) return emptyResult('llm-failed', 'LLM call failed');

  let actions: ConsolidationActions;
  try {
    actions = JSON.parse(
      raw.replace(/^```json?\s*/, '').replace(/\s*```$/, ''),
    ) as ConsolidationActions;
  } catch {
    logger.warn({ projectId, raw: raw.slice(0, 200) }, 'memory.consolidation: parse failed');
    return emptyResult('parse-failed', 'failed to parse LLM response');
  }

  // --- Execute (capped, id-validated, archive-only) ----------------------
  let created = 0;
  for (const item of (Array.isArray(actions.create) ? actions.create : []).slice(0, MAX_CREATES)) {
    if (typeof item.content !== 'string' || item.content.trim().length < 5) continue;
    const category = VALID_CATEGORIES.has(item.category as string)
      ? (item.category as string)
      : 'convention';
    const refHash = crypto.createHash('sha1').update(item.content).digest('hex').slice(0, 12);
    try {
      await indexMemory(
        {
          projectId,
          source: 'knowledge',
          sourceRef: `consolidated:${refHash}`,
          text: item.content.trim(),
          metadata: { category, origin: 'consolidation' },
        },
        { semanticDedup: true },
      );
      created++;
    } catch (err) {
      logger.warn(
        { err: (err as Error).message, projectId },
        'memory.consolidation: create failed',
      );
    }
  }

  let updated = 0;
  for (const item of (Array.isArray(actions.update) ? actions.update : []).slice(0, MAX_UPDATES)) {
    if (typeof item.id !== 'string' || typeof item.newContent !== 'string') continue;
    const row = byId.get(item.id);
    if (!row) {
      logger.debug({ projectId, id: item.id }, 'memory.consolidation: update for unknown id');
      continue;
    }
    try {
      // Natural-key upsert re-embeds the merged content on the SAME row;
      // metadata is preserved and tagged with the consolidation origin.
      await indexMemory({
        projectId,
        source: row.source,
        sourceRef: row.sourceRef,
        text: item.newContent.trim(),
        metadata: {
          ...((row.metadata ?? {}) as Record<string, unknown>),
          origin: 'consolidation',
        },
      });
      updated++;
    } catch (err) {
      logger.warn(
        { err: (err as Error).message, projectId },
        'memory.consolidation: update failed',
      );
    }
  }

  const archiveIds = (Array.isArray(actions.archive) ? actions.archive : [])
    .filter((id): id is string => typeof id === 'string' && byId.has(id))
    .slice(0, MAX_ARCHIVES);
  let archived = 0;
  if (archiveIds.length > 0) {
    const rows = await db
      .update(memories)
      .set({ archivedAt: sql`now()` })
      .where(
        and(
          eq(memories.projectId, projectId),
          inArray(memories.id, archiveIds),
          inArray(memories.source, [...CONSOLIDATABLE_SOURCES]),
        ),
      )
      .returning({ id: memories.id });
    archived = rows.length;
  }

  const summary =
    typeof actions.summary === 'string' && actions.summary
      ? actions.summary
      : `created ${created}, updated ${updated}, archived ${archived}`;

  // Audit trail: a decision memory row, searchable like any other.
  if (created + updated + archived > 0) {
    await indexMemoryBestEffort({
      projectId,
      source: 'decision',
      sourceRef: `consolidation:${new Date().toISOString().slice(0, 10)}`,
      text: `Memory consolidation: ${summary} (created: ${created}, updated: ${updated}, archived: ${archived})`,
      metadata: { cause: 'memory-consolidation' },
    });
  }

  // AC3 (ISS-568): propose durable lessons for knowledge promotion — best-effort,
  // never breaks consolidation.
  try {
    await proposeKnowledgePromotions(projectId);
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, projectId },
      'memory.consolidation: proposeKnowledgePromotions failed',
    );
  }

  return { created, updated, archived, summary };
}

/** Sweep every project that actually has consolidatable memory rows. */
export async function runConsolidationSweep(): Promise<{
  projects: number;
  durationMs: number;
}> {
  const t0 = Date.now();
  const projectRows = await db
    .selectDistinct({ projectId: memories.projectId })
    .from(memories)
    .where(and(inArray(memories.source, [...CONSOLIDATABLE_SOURCES]), isNull(memories.archivedAt)));

  for (const { projectId } of projectRows) {
    try {
      const result = await runConsolidationForProject(projectId);
      if (!result.skipped) {
        logger.info({ projectId, ...result }, 'memory.consolidation: project complete');
      }
    } catch (err) {
      logger.warn(
        { err: (err as Error).message, projectId },
        'memory.consolidation: project failed',
      );
    }
  }
  return { projects: projectRows.length, durationMs: Date.now() - t0 };
}

// ── ISS-708: release-triggered reconciliation ─────────────────────────────
//
// Closes the code→memory loop that the nightly consolidation above cannot:
// that pass only reacts to comments/status-changes/reopens from the last
// 24h and never reads `releaseNotes`. This one fires once per issue, when
// `merged_at` lands (see `registerMemoryReconcileTrigger`), and asks "which
// existing note/knowledge memories does THIS release's text contradict?"
//
// Two-tier, conservative-biased action (mirrors the archive-with-evidence
// bar already enforced by `feedback-service.ts`):
//  - CONTRADICTED  → hard-archive via the evidence-gated `runMemoryFeedback`.
//  - POSSIBLY_STALE → non-destructive: stamp `metadata.staleSince` +
//    `supersededBy` only. Surfaces as the `search.ts` read-side badge and
//    becomes decay-eligible after the `STALE_UNCONFIRMED_DAYS` grace period
//    if nobody re-confirms it (see `decay.ts`).
//  - UNAFFECTED    → skip.
//
// No git diff is persisted anywhere in core (confirmed at clarify) — the
// signal is release text only (`releaseNotes` + title + description/plan).
// A thin/`Skip`-section release yields a weak sweep; acceptable per the
// plan's known-limitations call.

export const MEMORY_RECONCILE_QUEUE = 'memory-reconcile';

/** Only memories scoring at/above this cosine floor are considered — bounds
 *  the LLM prompt to genuinely related candidates. */
export const RECONCILE_SCORE_FLOOR = 0.6;
export const RECONCILE_TOP_K = 15;
export const RECONCILE_MAX_CANDIDATES = 10;
const RECONCILE_SOURCES = ['note', 'knowledge'] as const;

// Concurrency guard, keyed per (project, issue) — a reopen→re-release racing
// the outbox retry must not run the sweep twice concurrently.
const runningReconciles = new Set<string>();

const RECONCILE_PROMPT = `You are a memory reconciliation agent for a software project management AI pipeline.

An issue just released. Decide which existing memories the release text CONTRADICTS.

## Release ({issue_ref})
{release_summary}

{release_text}

## Candidate memories (semantically related, pre-dating this release)
{candidates}

## Classify EACH candidate id into exactly one bucket
- **contradicted** — the release text DIRECTLY invalidates this memory (e.g. it describes a
  structure/flow/field the release removed or replaced). Include one-sentence \`evidence\`
  quoting or paraphrasing the specific release fact that disproves it.
- **possiblyStale** — the release plausibly affects this memory's area, but you cannot be sure
  it is actually wrong now (default here when uncertain).
- **unaffected** — the release does not bear on this memory at all.

Be conservative: only use \`contradicted\` when you are confident the release text disproves the
memory outright. When unsure, prefer \`possiblyStale\` over \`contradicted\`.

## Output JSON only (no markdown, no explanation):
{
  "contradicted": [{ "id": "<memory id>", "evidence": "..." }],
  "possiblyStale": [{ "id": "<memory id>" }],
  "unaffected": ["<memory id>", "..."]
}`;

interface ReconcileActions {
  contradicted?: Array<{ id?: unknown; evidence?: unknown }>;
  possiblyStale?: Array<{ id?: unknown }>;
  unaffected?: unknown[];
}

export interface ReconcileResult {
  contradicted: number;
  possiblyStale: number;
  summary: string;
  skipped?:
    | 'disabled'
    | 'running'
    | 'already-reconciled'
    | 'issue-not-found'
    | 'no-signal'
    | 'embeddings-unavailable'
    | 'llm-failed'
    | 'parse-failed';
}

function emptyReconcileResult(
  skipped: NonNullable<ReconcileResult['skipped']>,
  summary: string,
): ReconcileResult {
  return { contradicted: 0, possiblyStale: 0, summary, skipped };
}

/**
 * Entry point called from the `transition` hook subscriber (via a durable
 * pg-boss job, see `registerMemoryReconcileTrigger`/`registerMemoryReconcileWorker`)
 * whenever an issue's `merged_at` lands. Best-effort: every failure mode
 * returns a `skipped` result rather than throwing, so a flaky reconcile never
 * blocks the release flow that triggered it.
 */
export async function reconcileForReleasedIssue(
  projectId: string,
  issueId: string,
): Promise<ReconcileResult> {
  if (!fastModelConfigured()) return emptyReconcileResult('disabled', 'LLM not configured');
  const key = `${projectId}:${issueId}`;
  if (runningReconciles.has(key)) {
    return emptyReconcileResult('running', 'reconcile already running for this issue');
  }
  runningReconciles.add(key);
  try {
    return await reconcile(projectId, issueId);
  } finally {
    runningReconciles.delete(key);
  }
}

async function reconcile(projectId: string, issueId: string): Promise<ReconcileResult> {
  const [issueRow] = await db
    .select({
      issSeq: issues.issSeq,
      title: issues.title,
      description: issues.description,
      plan: issues.plan,
      releaseNotes: issues.releaseNotes,
      mergedAt: issues.mergedAt,
    })
    .from(issues)
    .where(eq(issues.id, issueId))
    .limit(1);
  if (!issueRow) return emptyReconcileResult('issue-not-found', 'issue not found');

  const issRef = `ISS-${issueRow.issSeq}`;
  const decisionRef = `reconcile:${issRef}`;

  // Idempotency: skip if this issue was already reconciled (reopen → re-release
  // re-fires the transition hook; don't double-spend LLM cost or re-archive).
  const [existing] = await db
    .select({ id: memories.id })
    .from(memories)
    .where(
      and(
        eq(memories.projectId, projectId),
        eq(memories.source, 'decision'),
        eq(memories.sourceRef, decisionRef),
      ),
    )
    .limit(1);
  if (existing) {
    return emptyReconcileResult('already-reconciled', `reconcile already recorded for ${issRef}`);
  }

  const releaseNotes = issueRow.releaseNotes;
  const releaseText = [
    releaseNotes?.userFacing,
    releaseNotes?.technical,
    issueRow.title,
    issueRow.description,
    issueRow.plan,
  ]
    .filter((s): s is string => Boolean(s?.trim()))
    .join('\n\n');
  if (!releaseText.trim()) return emptyReconcileResult('no-signal', 'no usable release text');

  let queryVec: number[];
  try {
    queryVec = await embed(releaseText.slice(0, MAX_EMBED_CHARS));
  } catch (err) {
    if (!(err instanceof EmbeddingUnavailableError)) throw err;
    return emptyReconcileResult('embeddings-unavailable', 'embeddings unavailable');
  }

  const hits = await searchMemories({
    projectId,
    queryVec,
    topK: RECONCILE_TOP_K,
    sourceFilter: [...RECONCILE_SOURCES],
  });

  // Only memories that PRE-DATE this release can be stale relative to it.
  const mergedAt = issueRow.mergedAt ?? new Date();
  const candidates = hits
    .filter((h) => h.score >= RECONCILE_SCORE_FLOOR && h.embeddedAt < mergedAt)
    .slice(0, RECONCILE_MAX_CANDIDATES);
  if (candidates.length === 0) {
    return emptyReconcileResult('no-signal', 'no candidate memories pre-date the release');
  }

  const byId = new Map<string, MemoryHit>(candidates.map((c) => [c.id, c]));
  const candidatesStr = candidates
    .map((c) => `- [${c.id}] [${c.source}] ${c.text.slice(0, 300)}`)
    .join('\n');
  const releaseSummary =
    [releaseNotes?.userFacing, releaseNotes?.technical].filter(Boolean).join(' — ') ||
    issueRow.title;

  const prompt = RECONCILE_PROMPT.replace('{issue_ref}', issRef)
    .replace('{release_summary}', releaseSummary)
    .replace('{release_text}', releaseText.slice(0, 4000))
    .replace('{candidates}', candidatesStr);

  const raw = await callFastModel(prompt, 1500);
  if (!raw) return emptyReconcileResult('llm-failed', 'LLM call failed');

  let actions: ReconcileActions;
  try {
    actions = JSON.parse(
      raw.replace(/^```json?\s*/, '').replace(/\s*```$/, ''),
    ) as ReconcileActions;
  } catch {
    logger.warn({ projectId, issueId, raw: raw.slice(0, 200) }, 'memory.reconcile: parse failed');
    return emptyReconcileResult('parse-failed', 'failed to parse LLM response');
  }

  let contradicted = 0;
  for (const item of (Array.isArray(actions.contradicted) ? actions.contradicted : []).slice(
    0,
    RECONCILE_MAX_CANDIDATES,
  )) {
    if (typeof item.id !== 'string' || typeof item.evidence !== 'string') continue;
    const candidate = byId.get(item.id);
    if (!candidate) continue;
    try {
      await runMemoryFeedback({
        projectId,
        source: candidate.source as 'note' | 'knowledge',
        sourceRef: candidate.sourceRef,
        verdict: 'outdated',
        evidence: `superseded by ${issRef}: ${item.evidence}`.slice(0, 2000),
      });
      contradicted++;
    } catch (err) {
      logger.warn(
        { err: (err as Error).message, projectId, issueId, memoryId: item.id },
        'memory.reconcile: contradicted archive failed',
      );
    }
  }

  let possiblyStale = 0;
  const staleSinceIso = mergedAt.toISOString();
  for (const item of (Array.isArray(actions.possiblyStale) ? actions.possiblyStale : []).slice(
    0,
    RECONCILE_MAX_CANDIDATES,
  )) {
    if (typeof item.id !== 'string') continue;
    const candidate = byId.get(item.id);
    if (!candidate) continue;
    try {
      const md = (candidate.metadata ?? {}) as Record<string, unknown>;
      const updated = await db
        .update(memories)
        .set({
          metadata: { ...md, staleSince: staleSinceIso, supersededBy: issRef },
          updatedAt: sql`now()`,
        })
        .where(eq(memories.id, candidate.id))
        .returning({ id: memories.id });
      if (updated.length > 0) possiblyStale++;
    } catch (err) {
      logger.warn(
        { err: (err as Error).message, projectId, issueId, memoryId: item.id },
        'memory.reconcile: possibly-stale stamp failed',
      );
    }
  }

  const summary = `reconcile ${issRef}: ${contradicted} contradicted, ${possiblyStale} possibly-stale of ${candidates.length} candidates`;

  // Audit trail, doubles as the idempotency guard above.
  await indexMemoryBestEffort({
    projectId,
    source: 'decision',
    sourceRef: decisionRef,
    text: summary,
    metadata: { cause: 'memory-reconcile', issueId, contradicted, possiblyStale },
  });

  return { contradicted, possiblyStale, summary };
}

let reconcileTriggerRegistered = false;

/**
 * Subscribe to the `transition` hook: whenever a status change lands the
 * issue's `merged_at` (leaving `mergeStates.baseBranch`, or reaching
 * `closed` — the same cross-project "code landed" predicate `merged-at.ts`
 * uses), enqueue a durable pg-boss reconcile job. Detached via
 * `queueMicrotask` (mirrors `registerMemoryIndexer`/`registerCiFixPatternLearner`)
 * so a slow project-config lookup never adds latency to the transition path.
 */
export function registerMemoryReconcileTrigger(bus: HooksBus): () => void {
  if (reconcileTriggerRegistered) return () => undefined;
  reconcileTriggerRegistered = true;

  const detach = (fn: () => Promise<void>) =>
    queueMicrotask(() => {
      fn().catch((err) => {
        logger.warn({ err: (err as Error).message }, 'memory.reconcile: trigger failed');
      });
    });

  const unsub = bus.on('transition', (payload) => {
    detach(async () => {
      const [projectRow] = await db
        .select({ agentConfig: projects.agentConfig })
        .from(projects)
        .where(eq(projects.id, payload.projectId))
        .limit(1);
      const { baseBranch } = resolveMergeStates(projectRow?.agentConfig);
      const mergeLanded =
        (payload.from === baseBranch && payload.to !== baseBranch) || payload.to === 'closed';
      if (!mergeLanded) return;

      await boss.send(
        MEMORY_RECONCILE_QUEUE,
        { projectId: payload.projectId, issueId: payload.issueId },
        { singletonKey: `${payload.issueId}:reconcile` },
      );
    });
  });

  return () => {
    unsub();
    reconcileTriggerRegistered = false;
  };
}

/** Test-only. */
export function resetMemoryReconcileTriggerForTest(): void {
  reconcileTriggerRegistered = false;
}

let reconcileWorkerRegistered = false;

/** Event-driven worker for `MEMORY_RECONCILE_QUEUE` — no schedule, unlike the
 *  nightly consolidation/decay sweeps; this runs once per merge-landed
 *  transition (enqueued by `registerMemoryReconcileTrigger`). */
export async function registerMemoryReconcileWorker(): Promise<void> {
  if (reconcileWorkerRegistered) return;
  // pg-boss v10 requires explicit createQueue before schedule/work can reference it.
  // biome-ignore lint/suspicious/noExplicitAny: pg-boss types vary across versions
  await (boss as any).createQueue(MEMORY_RECONCILE_QUEUE);
  // biome-ignore lint/suspicious/noExplicitAny: pg-boss handler arg type varies across versions
  await (boss as any).work(MEMORY_RECONCILE_QUEUE, { batchSize: 1 }, async (arg: any) => {
    const entries = Array.isArray(arg) ? arg : [arg];
    for (const entry of entries) {
      const data = entry?.data as { projectId?: string; issueId?: string } | undefined;
      if (!data?.projectId || !data.issueId) continue;
      try {
        const result = await reconcileForReleasedIssue(data.projectId, data.issueId);
        logger.info(
          { projectId: data.projectId, issueId: data.issueId, ...result },
          'memory.reconcile: complete',
        );
      } catch (err) {
        logger.error(
          { err, projectId: data.projectId, issueId: data.issueId },
          'memory.reconcile: failed',
        );
        throw err;
      }
    }
  });
  reconcileWorkerRegistered = true;
}

export function resetMemoryReconcileWorkerForTest(): void {
  reconcileWorkerRegistered = false;
}

let registered = false;

export async function registerMemoryConsolidation(): Promise<void> {
  if (registered) return;
  // pg-boss v10 requires explicit createQueue before schedule/work can reference it.
  // biome-ignore lint/suspicious/noExplicitAny: pg-boss types vary across versions
  await (boss as any).createQueue(MEMORY_CONSOLIDATION_QUEUE);
  // biome-ignore lint/suspicious/noExplicitAny: pg-boss types vary across versions
  await (boss as any).work(MEMORY_CONSOLIDATION_QUEUE, async () => {
    try {
      const result = await runConsolidationSweep();
      logger.info(result, 'memory.consolidation: sweep complete');
    } catch (err) {
      logger.error({ err }, 'memory.consolidation: sweep failed');
      throw err;
    }
  });
  // 03:00 — before the 03:30 decay sweep (proposal: consolidate, then decay).
  // biome-ignore lint/suspicious/noExplicitAny: pg-boss types vary across versions
  await (boss as any).schedule(MEMORY_CONSOLIDATION_QUEUE, '0 3 * * *');
  registered = true;
}

export function resetMemoryConsolidationForTest(): void {
  registered = false;
}
