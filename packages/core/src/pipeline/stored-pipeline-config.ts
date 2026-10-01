/**
 * ISS-1368 — a stored `pipelineConfig` the schema refuses is refused by name, never read as no
 * configuration or the defaults (which silently turns a project off) nor trimmed into a guess.
 * Each refused key carries its stored value, so the correcting patch can name it as its base.
 */

import { HTTPException } from 'hono/http-exception';
import { type PipelineConfig, pipelineConfigSchema } from './pipeline-config-schema.js';

export interface RefusedPipelineKey {
  /** Where the schema refused it, from the document's root: `pipelineConfig.releaseRuntimes.0.paths.0`. */
  readonly path: string;
  readonly message: string;
  readonly key: string;
  readonly stored: unknown;
}

export const PIPELINE_CONFIG_UNREADABLE = 'PIPELINE_CONFIG_UNREADABLE';

function sentence(projectId: string, refused: readonly RefusedPipelineKey[]): string {
  const each = refused.map((r) => `${r.path}: ${r.message}`).join('; ');
  const keys = [...new Set(refused.map((r) => `\`${r.key}\``))].join(', ');
  const stored = refused
    .filter((r, i) => refused.findIndex((o) => o.key === r.key) === i)
    .map((r) => `\`${r.key}\` is ${JSON.stringify(r.stored)}`)
    .join('; ');
  return (
    `project ${projectId}'s stored pipelineConfig is refused by the schema, so nothing reads it — ` +
    `not as no configuration and not as the defaults: ${each}. Correct ${keys} with a ` +
    `pipeline-config patch whose base is the value stored there (${stored}).`
  );
}

export class PipelineConfigUnreadable extends HTTPException {
  readonly projectId: string;
  readonly refused: readonly RefusedPipelineKey[];
  /** `written` says a patch landed before the read that refused what it left. */
  constructor(projectId: string, refused: readonly RefusedPipelineKey[], written = false) {
    const landed = written ? 'The patch was written, and ' : '';
    const message = `${landed}${sentence(projectId, refused)}`;
    const details = { projectId, refused };
    super(409, { message, cause: { code: PIPELINE_CONFIG_UNREADABLE, details } });
    this.name = 'PipelineConfigUnreadable';
    this.projectId = projectId;
    this.refused = refused;
  }
}

/** Only an absent key is no configuration; a stored `null` is a value, and the schema refuses it. */
function parseStored(stored: unknown) {
  return pipelineConfigSchema.safeParse(stored === undefined ? {} : stored);
}

/** The keys the schema refuses in a stored document, or an empty list where it reads. */
export function refusedPipelineKeys(stored: unknown): RefusedPipelineKey[] {
  const parsed = parseStored(stored);
  if (parsed.success) return [];
  const doc = (stored ?? {}) as Record<string, unknown>;
  return parsed.error.issues.map((issue) => {
    const key = String(issue.path[0] ?? '');
    return {
      path: ['pipelineConfig', ...issue.path].join('.'),
      message: issue.message,
      key,
      stored: key === '' ? stored : doc[key],
    };
  });
}

/** The project's configuration, or the refusal naming every key the schema refuses. */
export function readStoredPipelineConfig(projectId: string, stored: unknown): PipelineConfig {
  const parsed = parseStored(stored);
  if (parsed.success) return parsed.data;
  throw new PipelineConfigUnreadable(projectId, refusedPipelineKeys(stored));
}
