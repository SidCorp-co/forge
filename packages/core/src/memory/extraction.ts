import { and, desc, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { comments, issues, type JobType, jobs, memories } from '../db/schema.js';
import { callFastModel, fastModelConfigured } from '../integrations/llm/index.js';
import { logger } from '../lib/logger.js';
import { consume } from '../outbox/index.js';
import { indexMemory } from './indexer.js';
import { factCategory, parseFencedJson, shortHash } from './model-output.js';
import { foreignScriptChars } from './script-guard.js';

const EXTRACTION_JOB_TYPES: ReadonlySet<JobType> = new Set(['review', 'test', 'fix']);
const MAX_FACTS = 3;
const MAX_COMMENTS = 8;
const MAX_COMMENT_CHARS = 500;
const MAX_EXISTING_FOR_PROMPT = 20;

// Ported Vietnamese prompt examples — the original deployment served
// Vietnamese-speaking teams and the "preserve the original language" rule
// depends on non-English examples being present.
const VI_EXAMPLE_CONVENTION = 'title format: [$page] mô tả ngắn gọn'; // i18n-allow: ported prompt example
const VI_EXAMPLE_GOOD = 'trang /employee lọc tìm kiếm cần tìm theo họ, tên đệm, tên'; // i18n-allow: ported prompt example

/**
 * Ported verbatim where possible — the pass/fail examples are battle-tested.
 * Placeholders: {existing_memories}, {issue_title}, {comments}.
 */
const EXTRACTION_PROMPT = `Extract reusable facts from this software-pipeline activity.

## Rules
- A fact must pass: "Would knowing this change how an agent works on a FUTURE issue?"
- Preserve the original language. Do not translate. Vietnamese facts stay Vietnamese.
- Max ${MAX_FACTS} facts. If nothing qualifies, output {"facts":[]}

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

## Output JSON only:
{"facts":[{"fact":"...","category":"preference|correction|convention|tool_pattern"}]}

{existing_memories}
Issue: {issue_title}
Recent activity:
{comments}`;

function hasMemoryWorthyContent(texts: string[]): boolean {
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
}

/** Tolerant parse of the model output; returns null on garbage. */
function parseExtractionOutput(raw: string): ParsedExtraction | null {
  const parsed = parseFencedJson<{ facts?: unknown }>(raw.trim());
  if (parsed === undefined) return null;
  const facts = (Array.isArray(parsed.facts) ? parsed.facts : [])
    .filter(
      (f): f is { fact: string; category?: string } =>
        typeof f === 'object' && f !== null && typeof (f as { fact?: unknown }).fact === 'string',
    )
    .filter((f) => f.fact.trim().length >= 5)
    .slice(0, MAX_FACTS)
    .map((f) => ({
      fact: f.fact.trim(),
      category: factCategory(f.category),
    }));
  return { facts };
}

interface ExtractionResult {
  facts: number;
  /** Items the model wrote in a script its input never used, dropped unstored (ISS-962). */
  refused: number;
  skipped?: 'disabled' | 'no-signal' | 'gated' | 'llm-failed' | 'parse-failed';
}

interface RefusedItem {
  text: string;
  chars: string[];
}

/**
 * The mechanical check ISS-962 asks for, applied to a parsed extraction.
 *
 * The prompt tells the model to preserve the input's language, and this is
 * what holds it to that: an item carrying a character whose script the input
 * never used does not reach `indexMemory`. Pure, so the
 * refusal is testable without a model or a database.
 */
function refuseForeignScript(
  parsed: ParsedExtraction,
  source: string,
): { kept: ParsedExtraction; refused: RefusedItem[] } {
  const refused: RefusedItem[] = [];
  const facts = parsed.facts.filter(({ fact }) => {
    const chars = foreignScriptChars(fact, source);
    if (chars.length === 0) return true;
    refused.push({ text: fact.slice(0, 60), chars });
    return false;
  });
  return { kept: { facts }, refused };
}

/** Existing knowledge as dedup context — the prompt-level guard; the indexer's semantic dedup is the hard guard behind it. */
async function existingMemoriesSection(projectId: string): Promise<string> {
  const existing = await db
    .select({ textContent: memories.textContent })
    .from(memories)
    .where(and(eq(memories.projectId, projectId), eq(memories.source, 'knowledge')))
    .orderBy(desc(memories.updatedAt))
    .limit(MAX_EXISTING_FOR_PROMPT);
  return existing.length > 0
    ? `Existing memories (don't duplicate):\n${existing
        .map((m) => `- ${m.textContent.slice(0, 150)}`)
        .join('\n')}\n`
    : '';
}

async function storeFacts(
  projectId: string,
  issueId: string,
  facts: ParsedExtraction['facts'],
): Promise<number> {
  let factsWritten = 0;
  for (const f of facts) {
    try {
      const result = await indexMemory(
        {
          projectId,
          source: 'knowledge',
          sourceRef: `extracted:${shortHash(f.fact)}`,
          text: f.fact,
          metadata: { category: f.category, origin: 'extraction', issueId },
        },
        { nearDuplicateProbe: true },
      );
      factsWritten++;
      logger.info(
        {
          projectId,
          issueId,
          category: f.category,
          nearDuplicateOf: result.nearDuplicateOf,
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
  return factsWritten;
}

async function runExtractionForIssue(
  projectId: string,
  issueId: string,
): Promise<ExtractionResult> {
  if (!fastModelConfigured()) return { facts: 0, refused: 0, skipped: 'disabled' };

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
  if (bodies.length === 0) return { facts: 0, refused: 0, skipped: 'no-signal' };
  if (!hasMemoryWorthyContent(bodies)) return { facts: 0, refused: 0, skipped: 'gated' };

  const existingStr = await existingMemoriesSection(projectId);
  const commentsStr = bodies
    .slice()
    .reverse()
    .map((b) => `- ${b.slice(0, MAX_COMMENT_CHARS)}`)
    .join('\n');

  const prompt = EXTRACTION_PROMPT.replace('{existing_memories}', existingStr)
    .replace('{issue_title}', issue?.title ?? 'unknown')
    .replace('{comments}', commentsStr);

  const raw = await callFastModel({ surface: 'issue.comments' }, prompt, 400);
  if (!raw) return { facts: 0, refused: 0, skipped: 'llm-failed' };
  const parsed = parseExtractionOutput(raw);
  if (!parsed) {
    logger.warn({ issueId, raw: raw.slice(0, 120) }, 'memory.extraction: parse failed');
    return { facts: 0, refused: 0, skipped: 'parse-failed' };
  }

  const { kept, refused } = refuseForeignScript(parsed, `${issue?.title ?? ''}\n${commentsStr}`);
  if (refused.length > 0) {
    logger.warn(
      { projectId, issueId, refused },
      'memory.extraction: refused output in a script its input never used',
    );
  }

  return { facts: await storeFacts(projectId, issueId, kept.facts), refused: refused.length };
}

/** After a review, test or fix job on an issue completes, extract its facts, handed off so the
 *  outbox worker is not held behind the model call. */
export function registerMemoryExtraction(): void {
  consume('job.transitioned', {
    name: 'memory-extraction',
    handle: async (p) => {
      if (p.to !== 'done' || !p.issueId) return;
      const [job] = await db
        .select({ type: jobs.type })
        .from(jobs)
        .where(eq(jobs.id, p.id))
        .limit(1);
      if (!job || !EXTRACTION_JOB_TYPES.has(job.type)) return;
      const { projectId, issueId, id: jobId } = p;
      queueMicrotask(() => {
        runExtractionForIssue(projectId, issueId).catch((err) => {
          logger.warn(
            { err: (err as Error).message, jobId, issueId },
            'memory.extraction: run failed',
          );
        });
      });
    },
  });
}
