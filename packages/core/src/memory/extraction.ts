import crypto from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { env } from '../config/env.js';
import { db } from '../db/client.js';
import { type JobType, comments, issues, knowledgeEdges, memories } from '../db/schema.js';
import { logger } from '../logger.js';
import type { HooksBus } from '../pipeline/hooks.js';
import { indexMemory } from './indexer.js';

/**
 * memory-v2 phase 3 — session-end fact extraction, ported from forge-agents
 * `agent/memory/extraction.ts` and adapted to forge's pipeline:
 *
 *  - Trigger: `jobCompleted` for review/test/fix jobs — the stages where
 *    corrections and lessons surface (triage/plan emit plans, not lessons).
 *  - Signal: the issue's recent comments (pipeline skills report verdicts,
 *    fixes, and user corrections there) — forge has no server-side
 *    conversation transcript.
 *  - Output: ≤3 facts written as `source:'knowledge'` (semantic dedup ON, so
 *    re-learned facts refine instead of duplicate) and ≤3 knowledge-graph
 *    edges with `issue:<id>` provenance.
 *
 * Disabled when LITELLM_API_URL is unset — same off-switch as the
 * predecessor. Everything is detached + best-effort: extraction must never
 * affect job finalization.
 */

export const EXTRACTION_JOB_TYPES: ReadonlySet<JobType> = new Set(['review', 'test', 'fix']);
const MAX_FACTS = 3;
const MAX_EDGES = 3;
const MAX_COMMENTS = 8;
const MAX_COMMENT_CHARS = 500;
const MAX_EXISTING_FOR_PROMPT = 20;
const VALID_CATEGORIES = ['preference', 'correction', 'convention', 'tool_pattern'] as const;

// Ported Vietnamese prompt examples — the original deployment served
// Vietnamese-speaking teams and the "preserve the original language" rule
// depends on non-English examples being present.
const VI_EXAMPLE_CONVENTION = 'title format: [$page] mô tả ngắn gọn'; // i18n-allow: ported prompt example
const VI_EXAMPLE_GOOD = 'trang /employee lọc tìm kiếm cần tìm theo họ, tên đệm, tên'; // i18n-allow: ported prompt example

/**
 * Ported verbatim where possible — the pass/fail examples are battle-tested.
 * Placeholders: {existing_memories}, {issue_title}, {comments}.
 */
const EXTRACTION_PROMPT = `Extract reusable facts and entity relationships from this software-pipeline activity.

## Rules
- A fact must pass: "Would knowing this change how an agent works on a FUTURE issue?"
- Preserve the original language. Do not translate. Vietnamese facts stay Vietnamese.
- Max ${MAX_FACTS} facts, max ${MAX_EDGES} edges. If nothing qualifies, output {"facts":[],"edges":[]}

## Categories
- preference: someone explicitly requested a behavior ("respond in Vietnamese", "sort by priority")
- correction: a wrong assumption was corrected ("no, deploy branch is master not main")
- convention: team/project rule or naming convention ("${VI_EXAMPLE_CONVENTION}")
- tool_pattern: a working command/API pattern that resolved an issue

## Good examples (extract these)
- "${VI_EXAMPLE_GOOD}" → convention
- "always use bullet points" → preference
- "API endpoint is /v2 not /v1" → correction
- "permission filter in backend, not chat filter" → correction

## Bad examples (output empty arrays for these)
- "review passed" → status, not a rule
- "fixed the failing test" → one-time action, not reusable
- "ISS-1 is the first issue" → trivial, no behavioral impact
- "the test job took 4 minutes" → narration of what happened

## Entity relationships (knowledge graph edges)
Extract subject→predicate→object when the activity reveals project structure.
Predicates: role_in, owns, depends_on, has_rule, has_convention, related_to, part_of, uses

## Output JSON only:
{"facts":[{"fact":"...","category":"preference|correction|convention|tool_pattern"}],"edges":[{"subject":"...","predicate":"...","object":"...","value":"optional detail"}]}

{existing_memories}
Issue: {issue_title}
Recent activity:
{comments}`;

/**
 * Cheap pre-LLM gate, ported from forge-agents. Correction language (incl.
 * Vietnamese) always passes; otherwise require at least one substantial
 * non-trivial line. Saves an LLM call on pure status chatter.
 */
export function hasMemoryWorthyContent(texts: string[]): boolean {
  const bodies = texts.map((t) => t.trim()).filter(Boolean);
  if (bodies.length === 0) return false;

  const correctionPatterns = /sai rồi|sai|wrong|không phải|no,\s|chỉnh|correct|actually|thực ra/i; // i18n-allow: Vietnamese correction markers, ported gate
  if (bodies.some((b) => correctionPatterns.test(b))) return true;

  const trivialPatterns =
    /^(hi|hello|hey|thanks|thank you|ok|yes|no|lgtm|approved|done|passed|failed)\b/i;
  return bodies.some((b) => b.length > 80 && !trivialPatterns.test(b));
}

interface ParsedExtraction {
  facts: Array<{ fact: string; category: string }>;
  edges: Array<{ subject: string; predicate: string; object: string; value?: string }>;
}

/** Tolerant parse of the model output; returns null on garbage. */
export function parseExtractionOutput(raw: string): ParsedExtraction | null {
  const jsonStr = raw
    .trim()
    .replace(/^```json?\s*/, '')
    .replace(/\s*```$/, '');
  let parsed: { facts?: unknown; edges?: unknown };
  try {
    parsed = JSON.parse(jsonStr) as { facts?: unknown; edges?: unknown };
  } catch {
    return null;
  }
  const facts = (Array.isArray(parsed.facts) ? parsed.facts : [])
    .filter(
      (f): f is { fact: string; category?: string } =>
        typeof f === 'object' && f !== null && typeof (f as { fact?: unknown }).fact === 'string',
    )
    .filter((f) => f.fact.trim().length >= 5)
    .slice(0, MAX_FACTS)
    .map((f) => ({
      fact: f.fact.trim(),
      category: VALID_CATEGORIES.includes(f.category as (typeof VALID_CATEGORIES)[number])
        ? (f.category as string)
        : 'convention',
    }));
  const edges = (Array.isArray(parsed.edges) ? parsed.edges : [])
    .filter(
      (e): e is { subject: string; predicate: string; object: string; value?: string } =>
        typeof e === 'object' &&
        e !== null &&
        typeof (e as { subject?: unknown }).subject === 'string' &&
        typeof (e as { predicate?: unknown }).predicate === 'string' &&
        typeof (e as { object?: unknown }).object === 'string',
    )
    .slice(0, MAX_EDGES)
    .map((e) => ({
      subject: e.subject.toLowerCase().trim(),
      predicate: e.predicate.toLowerCase().trim(),
      object: e.object.toLowerCase().trim(),
      ...(typeof e.value === 'string' ? { value: e.value } : {}),
    }))
    .filter((e) => e.subject && e.predicate && e.object);
  return { facts, edges };
}

async function callExtractionModel(prompt: string): Promise<string | null> {
  if (!env.LITELLM_API_URL) return null;
  const response = await fetch(`${env.LITELLM_API_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(env.LITELLM_API_KEY ? { Authorization: `Bearer ${env.LITELLM_API_KEY}` } : {}),
    },
    body: JSON.stringify({
      model: env.LITELLM_MODEL,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 400,
      temperature: 0,
    }),
  });
  if (!response.ok) {
    logger.warn({ status: response.status }, 'memory.extraction: LLM call failed');
    return null;
  }
  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  return data.choices?.[0]?.message?.content?.trim() || null;
}

export interface ExtractionResult {
  facts: number;
  edges: number;
  skipped?: 'disabled' | 'no-signal' | 'gated' | 'llm-failed' | 'parse-failed';
}

export async function runExtractionForIssue(
  projectId: string,
  issueId: string,
): Promise<ExtractionResult> {
  if (!env.LITELLM_API_URL) return { facts: 0, edges: 0, skipped: 'disabled' };

  const [issue] = await db
    .select({ title: issues.title })
    .from(issues)
    .where(eq(issues.id, issueId))
    .limit(1);
  const recentComments = await db
    .select({ body: comments.body })
    .from(comments)
    .where(eq(comments.issueId, issueId))
    .orderBy(desc(comments.createdAt))
    .limit(MAX_COMMENTS);
  const bodies = recentComments.map((c) => c.body);
  if (bodies.length === 0) return { facts: 0, edges: 0, skipped: 'no-signal' };
  if (!hasMemoryWorthyContent(bodies)) return { facts: 0, edges: 0, skipped: 'gated' };

  // Existing knowledge as dedup context — the prompt-level guard; the
  // indexer's semantic dedup is the hard guard behind it.
  const existing = await db
    .select({ textContent: memories.textContent })
    .from(memories)
    .where(and(eq(memories.projectId, projectId), eq(memories.source, 'knowledge')))
    .orderBy(desc(memories.updatedAt))
    .limit(MAX_EXISTING_FOR_PROMPT);
  const existingStr =
    existing.length > 0
      ? `Existing memories (don't duplicate):\n${existing
          .map((m) => `- ${m.textContent.slice(0, 150)}`)
          .join('\n')}\n`
      : '';

  const commentsStr = bodies
    .slice()
    .reverse()
    .map((b) => `- ${b.slice(0, MAX_COMMENT_CHARS)}`)
    .join('\n');

  const prompt = EXTRACTION_PROMPT.replace('{existing_memories}', existingStr)
    .replace('{issue_title}', issue?.title ?? 'unknown')
    .replace('{comments}', commentsStr);

  const raw = await callExtractionModel(prompt);
  if (!raw) return { facts: 0, edges: 0, skipped: 'llm-failed' };
  const parsed = parseExtractionOutput(raw);
  if (!parsed) {
    logger.warn({ issueId, raw: raw.slice(0, 120) }, 'memory.extraction: parse failed');
    return { facts: 0, edges: 0, skipped: 'parse-failed' };
  }

  let factsWritten = 0;
  for (const f of parsed.facts) {
    const refHash = crypto.createHash('sha1').update(f.fact).digest('hex').slice(0, 12);
    try {
      const result = await indexMemory(
        {
          projectId,
          source: 'knowledge',
          sourceRef: `extracted:${refHash}`,
          text: f.fact,
          metadata: { category: f.category, origin: 'extraction', issueId },
        },
        { semanticDedup: true },
      );
      factsWritten++;
      logger.info(
        {
          projectId,
          issueId,
          category: f.category,
          dedupedInto: result.dedupedInto,
          fact: f.fact.slice(0, 60),
        },
        'memory.extraction: fact stored',
      );
    } catch (err) {
      logger.warn(
        { err: (err as Error).message, issueId, fact: f.fact.slice(0, 60) },
        'memory.extraction: fact write failed',
      );
    }
  }

  let edgesWritten = 0;
  for (const e of parsed.edges) {
    try {
      const [dupe] = await db
        .select({ id: knowledgeEdges.id })
        .from(knowledgeEdges)
        .where(
          and(
            eq(knowledgeEdges.projectId, projectId),
            eq(knowledgeEdges.subject, e.subject),
            eq(knowledgeEdges.predicate, e.predicate),
            eq(knowledgeEdges.object, e.object),
          ),
        )
        .limit(1);
      if (dupe) continue;
      await db.insert(knowledgeEdges).values({
        projectId,
        subject: e.subject,
        predicate: e.predicate,
        object: e.object,
        value: e.value ?? null,
        sourceMemoryId: `issue:${issueId}`,
      });
      edgesWritten++;
    } catch (err) {
      logger.warn(
        { err: (err as Error).message, issueId, subject: e.subject },
        'memory.extraction: edge write failed',
      );
    }
  }

  return { facts: factsWritten, edges: edgesWritten };
}

let alreadyRegistered = false;

export function registerMemoryExtraction(bus: HooksBus): () => void {
  if (alreadyRegistered) return () => undefined;
  alreadyRegistered = true;

  const unsub = bus.on('jobCompleted', (p) => {
    if (!p.issueId || !EXTRACTION_JOB_TYPES.has(p.type)) return;
    const { projectId, issueId, jobId } = p;
    // Detached: extraction adds an LLM round-trip and must never delay or
    // fail job finalization.
    queueMicrotask(() => {
      runExtractionForIssue(projectId, issueId as string).catch((err) => {
        logger.warn(
          { err: (err as Error).message, jobId, issueId },
          'memory.extraction: run failed',
        );
      });
    });
  });

  return () => {
    unsub();
    alreadyRegistered = false;
  };
}

/** Test-only. */
export function resetMemoryExtractionRegistration(): void {
  alreadyRegistered = false;
}
