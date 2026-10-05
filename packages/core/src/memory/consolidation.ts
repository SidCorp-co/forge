import crypto from 'node:crypto';
import { and, desc, eq, gte, inArray, isNull, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { activityLog, comments, issues, memories, projects } from '../db/schema.js';
import {
  callFastModel,
  EmbeddingUnavailableError,
  embed,
  fastModelConfigured,
} from '../integrations/llm/index.js';
import { searchKnowledge } from '../knowledge/index.js';
import { logger } from '../lib/logger.js';
import { indexMemory, indexMemoryBestEffort, MAX_EMBED_CHARS } from './indexer.js';
import { memoryOfLiveIssue } from './live-issue.js';
import {
  factCategory,
  firstItems,
  parseFencedJson,
  type ScriptRefuser,
  scriptRefuser,
  shortHash,
} from './model-output.js';
import { searchMemories } from './search.js';
import { NEAR_DUPLICATE_THRESHOLD } from './thresholds.js';

/**
 * Nightly consolidation, adapted from forge-agents' "dream" (`services/memory-dream/`). Differences:
 *
 *  - ARCHIVE replaces PRUNE: the LLM can hide rows (`archived_at`), never
 *    hard-delete them. A later write to the same key revives the row, and
 *    the decay job purges archives only after a 90-day grace period.
 *  - PROMOTE is dropped — no role hierarchy in forge.
 *  - A cluster timer (`timer-registry.ts`) at 03:00, before the 03:30 decay
 *    sweep, so freshly-merged rows are not double-processed.
 *
 * Signal (last 24h, per project): pipeline comments, status changes and reopen cycles, a reopen
 * meaning the fix or review was wrong. Nothing of an archived issue is read, signal or memory.
 */

const MAX_CREATES = 5;
const MAX_UPDATES = 5;
const MAX_ARCHIVES = 10;
const MAX_MEMORIES_FOR_PROMPT = 200;
const MAX_SIGNAL_COMMENTS = 100;
const MAX_SIGNAL_STATUS_CHANGES = 200;
const SIGNAL_WINDOW_MS = 24 * 60 * 60 * 1000;
const CONSOLIDATABLE_SOURCES = ['note', 'knowledge'] as const;

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

interface ConsolidationResult {
  created: number;
  updated: number;
  archived: number;
  /** Items the model wrote in a script the prompt never showed it, dropped unstored (ISS-962). */
  refused: number;
  summary: string;
  skipped?: 'disabled' | 'running' | 'no-signal' | 'llm-failed' | 'parse-failed';
}

function emptyResult(
  skipped: NonNullable<ConsolidationResult['skipped']>,
  summary: string,
): ConsolidationResult {
  return { created: 0, updated: 0, archived: 0, refused: 0, summary, skipped };
}

async function runConsolidationForProject(projectId: string): Promise<ConsolidationResult> {
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

async function alreadyRecorded(projectId: string, vector: number[]): Promise<string | null> {
  const [curated] = await searchKnowledge(projectId, vector, 1);
  if (curated && curated.score > NEAR_DUPLICATE_THRESHOLD)
    return `knowledge_entries:${curated.slug}`;
  const [mem] = await searchMemories({
    projectId,
    queryVec: vector,
    topK: 1,
    sourceFilter: ['knowledge'],
  });
  if (mem && mem.score > NEAR_DUPLICATE_THRESHOLD) return `memory:${mem.sourceRef}`;
  return null;
}

async function applyCreates(
  projectId: string,
  items: ConsolidationActions['create'],
  guard: ScriptRefuser,
): Promise<{ created: number; skipped: string[] }> {
  let created = 0;
  const skipped: string[] = [];
  for (const item of firstItems(items, MAX_CREATES)) {
    if (typeof item.content !== 'string' || item.content.trim().length < 5) continue;
    if (guard.refuse(item.content, 'create')) continue;
    const category = factCategory(item.category);
    const text = item.content.trim();
    const refHash = shortHash(item.content);
    try {
      const vector = await embed({ surface: 'memory' }, text.slice(0, MAX_EMBED_CHARS));
      const covered = await alreadyRecorded(projectId, vector);
      if (covered) {
        skipped.push(covered);
        continue;
      }
      await indexMemory({
        projectId,
        source: 'knowledge',
        sourceRef: `consolidated:${refHash}`,
        text,
        metadata: { category, origin: 'consolidation' },
      });
      created++;
    } catch (err) {
      if (err instanceof EmbeddingUnavailableError) throw err;
      logger.warn(
        { err: (err as Error).message, projectId },
        'memory.consolidation: create failed',
      );
    }
  }
  return { created, skipped };
}

async function applyUpdates(
  projectId: string,
  items: ConsolidationActions['update'],
  byId: Map<string, ConsolidatableRow>,
  guard: ScriptRefuser,
): Promise<number> {
  let updated = 0;
  for (const item of firstItems(items, MAX_UPDATES)) {
    if (typeof item.id !== 'string' || typeof item.newContent !== 'string') continue;
    if (guard.refuse(item.newContent, 'update')) continue;
    const row = byId.get(item.id);
    if (!row) {
      logger.debug({ projectId, id: item.id }, 'memory.consolidation: update for unknown id');
      continue;
    }
    try {
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
  return updated;
}

/** Archive the ids the model named that it was shown; the archived rows' refs. */
async function applyArchives(
  projectId: string,
  items: ConsolidationActions['archive'],
  byId: Map<string, ConsolidatableRow>,
): Promise<string[]> {
  const archiveIds = (Array.isArray(items) ? items : [])
    .filter((id): id is string => typeof id === 'string' && byId.has(id))
    .slice(0, MAX_ARCHIVES);
  if (archiveIds.length === 0) return [];
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
    .returning({ sourceRef: memories.sourceRef });
  return rows.map((r) => r.sourceRef);
}

/** One `- ` line per row, or `None` — the shape every prompt section takes. */
function bullets<T>(rows: readonly T[], line: (row: T) => string): string {
  return rows.length > 0 ? rows.map((r) => `- ${line(r)}`).join('\n') : 'None';
}

/** The last day's pipeline comments and status changes, archived issues left out. */
async function readSignal(projectId: string) {
  const since = new Date(Date.now() - SIGNAL_WINDOW_MS);

  const recentComments = await db
    .select({ body: comments.body, issueTitle: issues.title })
    .from(comments)
    .innerJoin(issues, and(eq(comments.issueId, issues.id), isNull(issues.archivedAt)))
    .where(and(eq(issues.projectId, projectId), gte(comments.createdAt, since)))
    .orderBy(desc(comments.createdAt))
    .limit(MAX_SIGNAL_COMMENTS);

  const statusChanges = await db
    .select({ payload: activityLog.payload, issueTitle: issues.title })
    .from(activityLog)
    .innerJoin(issues, and(eq(activityLog.issueId, issues.id), isNull(issues.archivedAt)))
    .where(
      and(
        eq(issues.projectId, projectId),
        eq(activityLog.action, 'issue.statusChanged'),
        gte(activityLog.createdAt, since),
      ),
    )
    .orderBy(desc(activityLog.createdAt))
    .limit(MAX_SIGNAL_STATUS_CHANGES);

  return { recentComments, statusChanges };
}

function readConsolidatable(projectId: string) {
  return db
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
        memoryOfLiveIssue(projectId),
      ),
    )
    .orderBy(desc(memories.updatedAt))
    .limit(MAX_MEMORIES_FOR_PROMPT);
}

type ConsolidatableRow = Awaited<ReturnType<typeof readConsolidatable>>[number];
type Signal = Awaited<ReturnType<typeof readSignal>>;

/** The four prompt sections, in prompt order. */
function promptSections(
  memoryRows: ConsolidatableRow[],
  signal: Signal,
): [string, string, string, string] {
  const changes = signal.statusChanges.map((sc) => {
    const p = (sc.payload ?? {}) as { from?: string; to?: string };
    return { issueTitle: sc.issueTitle, from: p.from ?? '', to: p.to ?? '' };
  });
  const reopens = changes.filter((c) => c.to === 'reopen');
  return [
    bullets(
      memoryRows,
      (m) =>
        `[${m.id}] [${m.source}] ${m.textContent.slice(0, 300)} (retrievals: ${m.retrievalCount})`,
    ),
    bullets(signal.recentComments, (c) => `${c.issueTitle}: ${c.body.slice(0, 400)}`),
    bullets(changes, (c) => `${c.issueTitle}: ${c.from} -> ${c.to}`),
    bullets(reopens, (r) => r.issueTitle),
  ];
}

async function recordConsolidation(
  projectId: string,
  counts: string,
  summary: string,
  archivedRefs: string[],
  skippedAsRecorded: string[],
): Promise<void> {
  await indexMemoryBestEffort({
    projectId,
    source: 'decision',
    sourceRef: `consolidation:${new Date().toISOString().slice(0, 10)}-${crypto.randomBytes(4).toString('hex')}`,
    text: `Memory consolidation: ${counts}${summary === counts ? '' : ` — ${summary}`}${archivedRefs.length > 0 ? `\narchived: ${archivedRefs.join(', ')}` : ''}${skippedAsRecorded.length > 0 ? `\nskipped, already recorded by: ${skippedAsRecorded.join(', ')}` : ''}`,
    metadata: { cause: 'memory-consolidation', archivedRefs, skippedAsRecorded },
  });
}

async function consolidate(projectId: string): Promise<ConsolidationResult> {
  const signal = await readSignal(projectId);
  if (signal.recentComments.length === 0 && signal.statusChanges.length === 0) {
    return emptyResult('no-signal', 'no recent signal to consolidate');
  }

  const memoryRows = await readConsolidatable(projectId);
  const byId = new Map(memoryRows.map((m) => [m.id, m]));
  const [memoriesStr, commentsStr, statusStr, reopenStr] = promptSections(memoryRows, signal);

  const prompt = CONSOLIDATION_PROMPT.replace('{memories}', memoriesStr)
    .replace('{recent_comments}', commentsStr)
    .replace('{status_changes}', statusStr)
    .replace('{reopen_cycles}', reopenStr);

  const raw = await callFastModel({ surface: 'issue' }, prompt, 2000);
  if (!raw) return emptyResult('llm-failed', 'LLM call failed');

  const actions = parseFencedJson<ConsolidationActions>(raw);
  if (actions === undefined) {
    logger.warn({ projectId, raw: raw.slice(0, 200) }, 'memory.consolidation: parse failed');
    return emptyResult('parse-failed', 'failed to parse LLM response');
  }

  const guard = scriptRefuser(
    projectId,
    `${memoriesStr}\n${commentsStr}\n${statusStr}\n${reopenStr}`,
    'memory.consolidation',
  );
  const { created, skipped: skippedAsRecorded } = await applyCreates(
    projectId,
    actions.create,
    guard,
  );
  const updated = await applyUpdates(projectId, actions.update, byId, guard);
  const archivedRefs = await applyArchives(projectId, actions.archive, byId);
  const archived = archivedRefs.length;

  const counts = `created ${created}, updated ${updated}, archived ${archived}${skippedAsRecorded.length > 0 ? `, skipped ${skippedAsRecorded.length} already recorded` : ''}`;
  const proposed =
    typeof actions.summary === 'string' && actions.summary ? actions.summary : counts;
  const summary = guard.refuse(proposed, 'summary') ? counts : proposed;

  if (created + updated + archived + skippedAsRecorded.length > 0) {
    await recordConsolidation(projectId, counts, summary, archivedRefs, skippedAsRecorded);
  }

  return { created, updated, archived, refused: guard.count, summary };
}

/** Sweep every project that actually has consolidatable memory rows. */
export async function runConsolidationSweep(): Promise<{
  projects: number;
  durationMs: number;
}> {
  const t0 = Date.now();
  const projectRows = await db
    .select({ projectId: projects.id })
    .from(projects)
    .where(
      sql`EXISTS (
        SELECT 1 FROM memories m
        WHERE m.project_id = "projects"."id"
          AND m.archived_at IS NULL
          AND m.source IN (${sql.join(
            CONSOLIDATABLE_SOURCES.map((source) => sql`${source}`),
            sql`, `,
          )})
      )`,
    );

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
