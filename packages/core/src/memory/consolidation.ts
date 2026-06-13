import crypto from 'node:crypto';
import { and, desc, eq, gte, inArray, isNull, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { activityLog, comments, issues, memories } from '../db/schema.js';
import { logger } from '../logger.js';
import { boss } from '../queue/boss.js';
import { indexMemory, indexMemoryBestEffort } from './indexer.js';
import { callFastModel, fastModelConfigured } from './llm.js';

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

// Concurrency guard — prevents overlapping runs for one project (scheduled
// sweep racing a manual trigger).
const runningProjects = new Set<string>();

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
      logger.warn({ err: (err as Error).message, projectId }, 'memory.consolidation: create failed');
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
      logger.warn({ err: (err as Error).message, projectId }, 'memory.consolidation: update failed');
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
