/** ISS-1368 — refused by name, never read as no configuration or the defaults; only an absent key is no configuration. */

import { type PipelineConfig, pipelineConfigSchema } from './pipeline-config-schema.js';
import { PipelineConfigUnreadable, type RefusedPipelineKey } from './pipeline-config-unreadable.js';

function parseStored(stored: unknown) {
  return pipelineConfigSchema.safeParse(stored === undefined ? {} : stored);
}

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

export function readStoredPipelineConfig(projectId: string, stored: unknown): PipelineConfig {
  const parsed = parseStored(stored);
  if (parsed.success) return parsed.data;
  throw new PipelineConfigUnreadable(projectId, refusedPipelineKeys(stored));
}

/** The stored document as stored, once the schema reads it — for a reader of its raw keys. */
export function readableStoredPipelineConfig(
  projectId: string,
  stored: unknown,
): Record<string, unknown> {
  readStoredPipelineConfig(projectId, stored);
  return (stored ?? {}) as Record<string, unknown>;
}
