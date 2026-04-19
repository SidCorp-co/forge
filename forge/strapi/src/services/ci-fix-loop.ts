/**
 * CI Fix Loop
 *
 * Automated CI failure recovery: parses build logs, triggers forge-fix via
 * the pipeline's reopen→fix flow, tracks attempts in sessionContext, and
 * stores successful fix patterns in Qdrant for preventive use.
 */

import { postPipelineComment } from './pipeline-utils';
import type { PipelineConfig } from './pipeline-antigravity';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface BuildError {
  type: 'typescript' | 'module_not_found' | 'env_missing' | 'docker' | 'npm' | 'generic';
  message: string;
  file?: string;
  line?: number;
  raw: string;
}

export interface CiFixContext {
  errors: BuildError[];
  attempt: number;
  maxAttempts: number;
  rawLogsTail: string;
  branch: string;
  previousAttempts: string[];
}

interface CiFixHistoryEntry {
  attempt: number;
  errors: BuildError[];
  timestamp: string;
  outcome: 'retrying' | 'fixed' | 'escalated';
}

// ─── Log Parser ─────────────────────────────────────────────────────────────

const ERROR_PATTERNS: Array<{
  type: BuildError['type'];
  regex: RegExp;
  extract: (match: RegExpMatchArray, line: string) => Partial<BuildError>;
}> = [
  {
    type: 'typescript',
    regex: /^(.+?)\((\d+),\d+\):\s*error\s+(TS\d+):\s*(.+)/,
    extract: (m) => ({ file: m[1], line: parseInt(m[2], 10), message: `${m[3]}: ${m[4]}` }),
  },
  {
    type: 'typescript',
    regex: /error\s+(TS\d+):\s*(.+)/,
    extract: (m) => ({ message: `${m[1]}: ${m[2]}` }),
  },
  {
    type: 'module_not_found',
    regex: /Module not found:\s*(.+)/i,
    extract: (m) => ({ message: m[1] }),
  },
  {
    type: 'module_not_found',
    regex: /Cannot find module\s+'([^']+)'/,
    extract: (m) => ({ message: `Cannot find module '${m[1]}'` }),
  },
  {
    type: 'env_missing',
    regex: /(env(?:ironment)?\s*(?:var(?:iable)?)?)\s+['"]?(\w+)['"]?\s+(?:is\s+)?not\s+(?:set|defined|found)/i,
    extract: (m) => ({ message: `Environment variable ${m[2]} not set` }),
  },
  {
    type: 'docker',
    regex: /ERROR\s+\[([^\]]+)\]\s*(.+)/,
    extract: (m) => ({ message: `Docker build error [${m[1]}]: ${m[2]}` }),
  },
  {
    type: 'docker',
    regex: /failed to solve:\s*(.+)/i,
    extract: (m) => ({ message: m[1] }),
  },
  {
    type: 'npm',
    regex: /npm ERR!\s*(.+)/,
    extract: (m) => ({ message: m[1] }),
  },
  {
    type: 'npm',
    regex: /Build failed/i,
    extract: () => ({ message: 'Build failed' }),
  },
];

/**
 * Parse build logs into structured errors.
 * Conservative: includes generic fallback for unrecognized error lines.
 */
export function parseBuildLogs(logs: string): BuildError[] {
  if (!logs) return [];

  const lines = logs.split('\n');
  const errors: BuildError[] = [];
  const seen = new Set<string>();

  for (const line of lines) {
    if (errors.length >= 10) break;
    const trimmed = line.trim();
    if (!trimmed) continue;

    for (const pattern of ERROR_PATTERNS) {
      const match = trimmed.match(pattern.regex);
      if (match) {
        const extracted = pattern.extract(match, trimmed);
        const key = `${pattern.type}:${extracted.message}`;
        if (seen.has(key)) break;
        seen.add(key);

        errors.push({
          type: pattern.type,
          message: extracted.message || trimmed,
          file: extracted.file,
          line: extracted.line,
          raw: trimmed.slice(0, 500),
        });
        break;
      }
    }
  }

  return errors;
}

// ─── Config Resolution ──────────────────────────────────────────────────────

interface CiFixConfig {
  enabled: boolean;
  maxAttempts: number;
}

function resolveCiFixConfig(pipelineConfig: PipelineConfig): CiFixConfig {
  const val = (pipelineConfig as any).autoCiFix;
  if (val === undefined || val === false) return { enabled: false, maxAttempts: 3 };
  if (val === true) return { enabled: true, maxAttempts: 3 };
  return {
    enabled: val.enabled !== false,
    maxAttempts: val.maxAttempts || 3,
  };
}

// ─── Auto-Fix Trigger ───────────────────────────────────────────────────────

/**
 * Main entry point: called by pipeline on build failure.
 * Returns true if auto-fix handled the failure, false if disabled/not applicable.
 */
export async function triggerAutoFix(
  strapi: any,
  issueDocumentId: string,
  logs: string,
  branch: string,
): Promise<boolean> {
  const issue = await strapi.documents('api::issue.issue').findOne({
    documentId: issueDocumentId,
    populate: ['project'],
  });
  if (!issue?.project) return false;

  const pipelineConfig: PipelineConfig = (issue.project as any).agentConfig?.pipelineConfig || { enabled: false };
  const config = resolveCiFixConfig(pipelineConfig);
  if (!config.enabled) return false;

  const ctx = issue.sessionContext || {};
  const attempts = ctx.ciFixAttempts || 0;
  const history: CiFixHistoryEntry[] = ctx.ciFixHistory || [];

  const errors = parseBuildLogs(logs);

  if (attempts >= config.maxAttempts) {
    // Escalate: too many attempts
    const summary = history
      .map((h: CiFixHistoryEntry) => `- Attempt ${h.attempt}: ${h.errors.map(e => e.message).join('; ')}`)
      .join('\n');

    history.push({
      attempt: attempts + 1,
      errors,
      timestamp: new Date().toISOString(),
      outcome: 'escalated',
    });

    await strapi.documents('api::issue.issue').update({
      documentId: issueDocumentId,
      data: {
        status: 'needs_info',
        sessionContext: {
          ...ctx,
          ciFixAttempts: attempts + 1,
          ciFixHistory: history.slice(-10),
        },
      },
    });

    await postPipelineComment(
      strapi,
      issueDocumentId,
      `**CI auto-fix exhausted** — ${attempts} attempts failed. Manual intervention needed.\n\n${summary}`,
      'Pikachu',
    );

    return true;
  }

  // Build fix context for forge-fix
  const ciFixContext: CiFixContext = {
    errors,
    attempt: attempts + 1,
    maxAttempts: config.maxAttempts,
    rawLogsTail: logs.slice(-2000),
    branch,
    previousAttempts: history.map(
      (h: CiFixHistoryEntry) => `Attempt ${h.attempt}: ${h.errors.map(e => e.message).join('; ')}`,
    ),
  };

  history.push({
    attempt: attempts + 1,
    errors,
    timestamp: new Date().toISOString(),
    outcome: 'retrying',
  });

  await strapi.documents('api::issue.issue').update({
    documentId: issueDocumentId,
    data: {
      status: 'reopen',
      sessionContext: {
        ...ctx,
        ciFixAttempts: attempts + 1,
        ciFixContext,
        ciFixHistory: history.slice(-10),
      },
    },
  });

  strapi.log.info(
    `[ci-fix] ISS-${issue.id}: auto-fix attempt ${attempts + 1}/${config.maxAttempts}, ${errors.length} error(s) parsed`,
  );

  return true;
}

// ─── Pattern Storage ────────────────────────────────────────────────────────

/**
 * Store a successful CI fix as a pattern in Qdrant for future prevention.
 * Called when an issue transitions reopen → developed with ciFixContext.
 */
export async function storeSuccessPattern(
  strapi: any,
  projectId: string,
  issueDocumentId: string,
): Promise<void> {
  const issue = await strapi.documents('api::issue.issue').findOne({
    documentId: issueDocumentId,
    fields: ['id', 'sessionContext', 'title'],
  });
  if (!issue) return;

  const ctx = issue.sessionContext || {};
  const ciFixContext: CiFixContext | undefined = ctx.ciFixContext;
  if (!ciFixContext?.errors?.length) return;

  const { upsertEmbedding } = await import('./embeddings');
  const { upsertEdge } = await import('./knowledge-graph');

  // Group errors by type for pattern creation
  const errorsByType = new Map<string, BuildError[]>();
  for (const err of ciFixContext.errors) {
    const existing = errorsByType.get(err.type) || [];
    existing.push(err);
    errorsByType.set(err.type, existing);
  }

  for (const [errorType, errors] of errorsByType) {
    const filePatterns = errors
      .filter(e => e.file)
      .map(e => e.file!)
      .join(', ');
    const messages = errors.map(e => e.message).join('; ');
    const patternText = `CI failure: ${errorType} — ${messages}. Fixed in issue ${issue.title}.`;

    // Hash for dedup
    const hash = Buffer.from(`${errorType}:${messages.slice(0, 100)}`).toString('base64url').slice(0, 16);
    const sourceId = `ci:${projectId}:${errorType}:${hash}`;

    await upsertEmbedding({
      project_id: projectId,
      source_type: 'ci_pattern',
      source_id: sourceId,
      text: patternText,
      metadata: {
        failureType: errorType,
        filePattern: filePatterns || undefined,
        successCount: 1,
        lastUsed: new Date().toISOString(),
        issueId: issue.id,
        updatedAt: new Date().toISOString(),
      },
    });

    // Knowledge graph edge
    await upsertEdge(strapi, projectId, {
      subject: errorType,
      predicate: 'fixed_by',
      object: patternText.slice(0, 100),
      value: `ISS-${issue.id}`,
    });
  }

  // Update history: mark last entry as fixed
  const history: CiFixHistoryEntry[] = ctx.ciFixHistory || [];
  if (history.length > 0) {
    history[history.length - 1].outcome = 'fixed';
  }

  // Clear ciFixContext, keep history
  await strapi.documents('api::issue.issue').update({
    documentId: issueDocumentId,
    data: {
      sessionContext: {
        ...ctx,
        ciFixContext: undefined,
        ciFixHistory: history,
      },
    },
  });

  strapi.log.info(
    `[ci-fix] ISS-${issue.id}: stored ${errorsByType.size} fix pattern(s) in Qdrant`,
  );

  // Check for recurring patterns (auto-promote suggestion)
  for (const [errorType] of errorsByType) {
    try {
      const { searchSimilar } = await import('./embeddings');
      const existing = await searchSimilar(projectId, `CI failure: ${errorType}`, 10, ['ci_pattern']);
      const sameType = existing.filter(
        (r: any) => r.payload.metadata?.failureType === errorType,
      );
      if (sameType.length >= 3) {
        await postPipelineComment(
          strapi,
          issueDocumentId,
          `CI pattern \`${errorType}\` has been fixed ${sameType.length} times. Consider adding to project coding standards via \`/lessons-learned\`.`,
          'Pikachu',
        );
      }
    } catch {
      // Non-critical — pattern promotion is advisory
    }
  }
}

/**
 * Query Qdrant for CI failure patterns matching the given files/modules.
 * Returns formatted guidance string for injection into forge-code prompt.
 */
export async function queryPreventivePatterns(
  _strapi: any,
  projectId: string,
  files: string[],
): Promise<string> {
  if (!files.length) return '';

  try {
    const { searchSimilar } = await import('./embeddings');
    const searchText = `CI failure patterns for files: ${files.join(', ')}`;
    const results = await searchSimilar(projectId, searchText, 5, ['ci_pattern']);

    if (!results.length) return '';

    const lines = results.map((r: any) => {
      const meta = r.payload.metadata || {};
      const type = meta.failureType || 'unknown';
      const text = r.payload.text || '';
      return `- **${type}**: ${text.slice(0, 200)}`;
    });

    return `## Known CI Pitfalls\n\n${lines.join('\n')}\n`;
  } catch {
    return '';
  }
}
