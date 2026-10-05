import { BASE_MERGE_STATE } from '@forge/contracts/issue-machine';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issues, memories, projects } from '../db/schema.js';
import {
  callFastModel,
  EmbeddingUnavailableError,
  embed,
  fastModelConfigured,
} from '../integrations/llm/index.js';
import { canonicalIssueKey, formatIssueRef } from '../lib/issue-ref.js';
import { logger } from '../lib/logger.js';
import { consume } from '../outbox/index.js';
import { boss } from '../queue/boss.js';
import { runMemoryFeedback } from './feedback-service.js';
import { indexMemoryBestEffort, MAX_EMBED_CHARS } from './indexer.js';
import { firstItems, parseFencedJson, type ScriptRefuser, scriptRefuser } from './model-output.js';
import { type MemoryHit, searchMemories } from './search.js';

// Closes the code→memory loop that the nightly consolidation cannot:
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

const MEMORY_RECONCILE_QUEUE = 'memory-reconcile';

/** Only memories scoring at/above this cosine floor are considered — bounds
 *  the LLM prompt to genuinely related candidates. */
const RECONCILE_SCORE_FLOOR = 0.6;
const RECONCILE_TOP_K = 15;
const RECONCILE_MAX_CANDIDATES = 10;
const RECONCILE_SOURCES = ['note', 'knowledge'] as const;

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

interface ReconcileResult {
  contradicted: number;
  possiblyStale: number;
  refused: number;
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

/** The issue and memories one reconcile acts on, and how it names them. */
interface ReconcileScope {
  projectId: string;
  issueId: string;
  issRef: string;
  byId: Map<string, MemoryHit>;
}

function emptyReconcileResult(
  skipped: NonNullable<ReconcileResult['skipped']>,
  summary: string,
): ReconcileResult {
  return { contradicted: 0, possiblyStale: 0, refused: 0, summary, skipped };
}

/**
 * Entry point called from the `transition` hook subscriber (via a durable
 * pg-boss job, see `registerMemoryReconcileTrigger`/`registerMemoryReconcileWorker`)
 * whenever an issue's `merged_at` lands. Best-effort: every failure mode
 * returns a `skipped` result rather than throwing, so a flaky reconcile never
 * blocks the release flow that triggered it.
 */
async function reconcileForReleasedIssue(
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

async function readReleasedIssue(projectId: string, issueId: string) {
  const [issueRow] = await db
    .select({
      issSeq: issues.issSeq,
      issuePrefix: projects.issuePrefix,
      title: issues.title,
      description: issues.description,
      plan: issues.plan,
      releaseNotes: issues.releaseNotes,
      mergedAt: issues.mergedAt,
    })
    .from(issues)
    .innerJoin(projects, eq(projects.id, issues.projectId))
    .where(and(eq(issues.id, issueId), eq(issues.projectId, projectId), isNull(issues.archivedAt)))
    .limit(1);
  return issueRow;
}

type ReleasedIssue = NonNullable<Awaited<ReturnType<typeof readReleasedIssue>>>;

async function alreadyReconciled(projectId: string, decisionRef: string): Promise<boolean> {
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
  return existing !== undefined;
}

function releaseTextOf(issueRow: ReleasedIssue): string {
  const releaseNotes = issueRow.releaseNotes;
  return [
    releaseNotes?.userFacing,
    releaseNotes?.technical,
    issueRow.title,
    issueRow.description,
    issueRow.plan,
  ]
    .filter((s): s is string => Boolean(s?.trim()))
    .join('\n\n');
}

async function candidatesFor(projectId: string, queryVec: number[], mergedAt: Date) {
  const hits = await searchMemories({
    projectId,
    queryVec,
    topK: RECONCILE_TOP_K,
    sourceFilter: [...RECONCILE_SOURCES],
  });
  return hits
    .filter((h) => h.score >= RECONCILE_SCORE_FLOOR && h.embeddedAt < mergedAt)
    .slice(0, RECONCILE_MAX_CANDIDATES);
}

async function archiveContradicted(
  scope: ReconcileScope,
  items: ReconcileActions['contradicted'],
  guard: ScriptRefuser,
): Promise<string[]> {
  const { projectId, issueId, issRef, byId } = scope;
  const contradictedRefs: string[] = [];
  for (const item of firstItems(items, RECONCILE_MAX_CANDIDATES)) {
    if (typeof item.id !== 'string' || typeof item.evidence !== 'string') continue;
    if (guard.refuse(item.evidence, 'evidence')) continue;
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
      contradictedRefs.push(candidate.sourceRef);
    } catch (err) {
      logger.warn(
        { err: (err as Error).message, projectId, issueId, memoryId: item.id },
        'memory.reconcile: contradicted archive failed',
      );
    }
  }
  return contradictedRefs;
}

async function stampPossiblyStale(
  scope: ReconcileScope,
  items: ReconcileActions['possiblyStale'],
  mergedAt: Date,
): Promise<string[]> {
  const { projectId, issueId, issRef, byId } = scope;
  const staleRefs: string[] = [];
  const staleSinceIso = mergedAt.toISOString();
  for (const item of firstItems(items, RECONCILE_MAX_CANDIDATES)) {
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
      if (updated.length > 0) staleRefs.push(candidate.sourceRef);
    } catch (err) {
      logger.warn(
        { err: (err as Error).message, projectId, issueId, memoryId: item.id },
        'memory.reconcile: possibly-stale stamp failed',
      );
    }
  }
  return staleRefs;
}

async function recordReconcile(
  scope: ReconcileScope,
  decisionRef: string,
  summary: string,
  contradictedRefs: string[],
  staleRefs: string[],
): Promise<void> {
  await indexMemoryBestEffort({
    projectId: scope.projectId,
    source: 'decision',
    sourceRef: decisionRef,
    text: `${summary}${contradictedRefs.length > 0 ? `\ncontradicted: ${contradictedRefs.join(', ')}` : ''}${staleRefs.length > 0 ? `\nstale-stamped: ${staleRefs.join(', ')}` : ''}`,
    metadata: {
      cause: 'memory-reconcile',
      issueId: scope.issueId,
      contradicted: contradictedRefs.length,
      possiblyStale: staleRefs.length,
      contradictedRefs,
      staleRefs,
    },
  });
}

async function reconcile(projectId: string, issueId: string): Promise<ReconcileResult> {
  const issueRow = await readReleasedIssue(projectId, issueId);
  if (!issueRow) {
    return emptyReconcileResult('issue-not-found', 'issue not found in this project, or archived');
  }

  const issRef = formatIssueRef(issueRow.issuePrefix, issueRow.issSeq);
  const decisionRef = `reconcile:${canonicalIssueKey(issueRow.issSeq)}`;

  // Idempotency: skip if this issue was already reconciled (reopen → re-release
  // re-fires the transition hook; don't double-spend LLM cost or re-archive).
  if (await alreadyReconciled(projectId, decisionRef)) {
    return emptyReconcileResult('already-reconciled', `reconcile already recorded for ${issRef}`);
  }

  const releaseText = releaseTextOf(issueRow);
  if (!releaseText.trim()) return emptyReconcileResult('no-signal', 'no usable release text');

  let queryVec: number[];
  try {
    queryVec = await embed({ surface: 'memory' }, releaseText.slice(0, MAX_EMBED_CHARS));
  } catch (err) {
    if (!(err instanceof EmbeddingUnavailableError)) throw err;
    return emptyReconcileResult('embeddings-unavailable', 'embeddings unavailable');
  }

  const mergedAt = issueRow.mergedAt ?? new Date();
  const candidates = await candidatesFor(projectId, queryVec, mergedAt);
  if (candidates.length === 0) {
    return emptyReconcileResult('no-signal', 'no candidate memories pre-date the release');
  }

  const candidatesStr = candidates
    .map((c) => `- [${c.id}] [${c.source}] ${c.text.slice(0, 300)}`)
    .join('\n');
  const releaseNotes = issueRow.releaseNotes;
  const releaseSummary =
    [releaseNotes?.userFacing, releaseNotes?.technical].filter(Boolean).join(' — ') ||
    issueRow.title;

  const prompt = RECONCILE_PROMPT.replace('{issue_ref}', issRef)
    .replace('{release_summary}', releaseSummary)
    .replace('{release_text}', releaseText.slice(0, 4000))
    .replace('{candidates}', candidatesStr);

  const raw = await callFastModel({ surface: 'memory' }, prompt, 1500);
  if (!raw) return emptyReconcileResult('llm-failed', 'LLM call failed');

  const actions = parseFencedJson<ReconcileActions>(raw);
  if (actions === undefined) {
    logger.warn({ projectId, issueId, raw: raw.slice(0, 200) }, 'memory.reconcile: parse failed');
    return emptyReconcileResult('parse-failed', 'failed to parse LLM response');
  }

  const guard = scriptRefuser(
    projectId,
    `${releaseText.slice(0, 4000)}\n${candidatesStr}`,
    'memory.reconcile',
  );
  const scope: ReconcileScope = {
    projectId,
    issueId,
    issRef,
    byId: new Map(candidates.map((c) => [c.id, c])),
  };
  const contradictedRefs = await archiveContradicted(scope, actions.contradicted, guard);
  const staleRefs = await stampPossiblyStale(scope, actions.possiblyStale, mergedAt);

  const contradicted = contradictedRefs.length;
  const possiblyStale = staleRefs.length;
  const summary = `reconcile ${issRef}: ${contradicted} contradicted, ${possiblyStale} possibly-stale of ${candidates.length} candidates`;
  await recordReconcile(scope, decisionRef, summary, contradictedRefs, staleRefs);

  return { contradicted, possiblyStale, refused: guard.count, summary };
}

/**
 * Whenever an issue move lands its `merged_at` (leaving {@link BASE_MERGE_STATE}, or reaching
 * `closed` — the "code landed" predicate `merged-at.ts` uses), enqueue a durable pg-boss reconcile
 * job, once per issue by its singleton key.
 */
export function registerMemoryReconcileTrigger(): void {
  consume('issue.transitioned', {
    name: 'memory-reconcile',
    handle: async (p) => {
      const mergeLanded =
        (p.from === BASE_MERGE_STATE && p.to !== BASE_MERGE_STATE) || p.to === 'closed';
      if (!mergeLanded) return;
      await boss.send(
        MEMORY_RECONCILE_QUEUE,
        { projectId: p.projectId, issueId: p.id },
        { singletonKey: `${p.id}:reconcile` },
      );
    },
  });
}

type ReconcileJob = { projectId?: string; issueId?: string };

let reconcileWorkerRegistered = false;

/** Event-driven worker for `MEMORY_RECONCILE_QUEUE` — no schedule, unlike the
 *  nightly consolidation/decay sweeps; this runs once per merge-landed
 *  transition (enqueued by `registerMemoryReconcileTrigger`). */
export async function registerMemoryReconcileWorker(): Promise<void> {
  if (reconcileWorkerRegistered) return;
  await boss.createQueue(MEMORY_RECONCILE_QUEUE);
  await boss.work<ReconcileJob>(MEMORY_RECONCILE_QUEUE, { batchSize: 1 }, async (jobs) => {
    for (const entry of jobs) {
      const data = entry.data;
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
