import { embed } from '../embeddings/index.js';
import { logger } from '../logger.js';
import { searchMemories } from '../memory/search.js';

/**
 * ISS-32 — Query side of CI fix pattern learning.
 *
 * Embeds the new issue's text, runs a similarity search against
 * `kind:'ci_fix_pattern'` memories in the same project, and returns up to
 * `maxPatterns` hits. The orchestrator injects these into
 * `payload.preventiveContext.patterns[]` so forge-code can avoid known
 * regressions before committing.
 *
 * Hard 5s timeout — embeddings or pgvector latency must not block the
 * orchestrator's enqueue path. On timeout / error / missing-config the
 * function returns `[]` and logs at warn (UC-edge: forge-code still
 * enqueues, just without the preventive context).
 */

const QUERY_TIMEOUT_MS = 5000;
const DEFAULT_MAX_PATTERNS = 3;
const SEARCH_TOP_K = 10;

export interface PreventivePattern {
  errorTypes: string[];
  fileTypes: string[];
  diffSummary: string;
  branch?: string;
  score: number;
}

export interface QueryPreventivePatternsInput {
  projectId: string;
  issueText: string;
  maxPatterns?: number;
}

interface PatternMetadata {
  kind?: string;
  errorTypes?: unknown;
  fileTypes?: unknown;
  diffSummary?: unknown;
  branch?: unknown;
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

async function runQuery(input: QueryPreventivePatternsInput): Promise<PreventivePattern[]> {
  const text = input.issueText.trim();
  if (!text) return [];
  const queryVec = await embed(text);
  const hits = await searchMemories({
    projectId: input.projectId,
    queryVec,
    topK: SEARCH_TOP_K,
    sourceFilter: ['note'],
    metadataFilter: { kind: 'ci_fix_pattern' },
  });

  const max = input.maxPatterns ?? DEFAULT_MAX_PATTERNS;
  const patterns: PreventivePattern[] = [];
  for (const hit of hits) {
    const meta = (hit.metadata ?? {}) as PatternMetadata;
    // Belt-and-braces: searchMemories already filters by metadata.kind, but guard
    // here too in case the filter API loosens in a future RAG refactor.
    if (meta.kind !== 'ci_fix_pattern') continue;
    const pattern: PreventivePattern = {
      errorTypes: asStringArray(meta.errorTypes),
      fileTypes: asStringArray(meta.fileTypes),
      diffSummary: typeof meta.diffSummary === 'string' ? meta.diffSummary : '',
      score: hit.score,
    };
    if (typeof meta.branch === 'string') pattern.branch = meta.branch;
    patterns.push(pattern);
    if (patterns.length >= max) break;
  }
  return patterns;
}

export async function queryPreventivePatterns(
  input: QueryPreventivePatternsInput,
): Promise<PreventivePattern[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<PreventivePattern[]>((resolve) => {
    timer = setTimeout(() => {
      logger.warn(
        { projectId: input.projectId, ms: QUERY_TIMEOUT_MS },
        'ci_fix_pattern.query: timed out, returning empty preventive context',
      );
      resolve([]);
    }, QUERY_TIMEOUT_MS);
    timer.unref?.();
  });

  // Attach the failure handler before racing so a late rejection (runQuery
  // rejects *after* the timeout has already resolved with []) is swallowed
  // here rather than escaping as an UnhandledPromiseRejection.
  const query = runQuery(input)
    .then((res) => {
      if (timer) clearTimeout(timer);
      return res;
    })
    .catch((err) => {
      if (timer) clearTimeout(timer);
      logger.warn(
        { err: (err as Error).message, projectId: input.projectId },
        'ci_fix_pattern.query: lookup failed, returning empty preventive context',
      );
      return [] as PreventivePattern[];
    });

  return Promise.race([query, timeout]);
}
