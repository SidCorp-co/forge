/**
 * ISS-1368 — the refusal of a stored `pipelineConfig` the schema refuses: the project, each refused
 * path and the value stored at its key. Kept free of the schema so a reader whose tests mock the
 * database schema can still tell this refusal apart.
 */

import { HTTPException } from 'hono/http-exception';

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
  const opens = `project ${projectId}'s stored pipelineConfig is refused by the schema, so nothing reads it — not as no configuration and not as the defaults: ${each}.`;
  const root = refused.find((r) => r.key === '');
  if (root) {
    return `${opens} It is stored as ${JSON.stringify(root.stored)} where an object of settings belongs: send a pipeline-config patch naming the keys to store, with an empty base, and it replaces that value.`;
  }
  const keys = [...new Set(refused.map((r) => `\`${r.key}\``))].join(', ');
  const stored = refused
    .filter((r, i) => refused.findIndex((o) => o.key === r.key) === i)
    .map((r) => `\`${r.key}\` is ${JSON.stringify(r.stored)}`)
    .join('; ');
  return `${opens} Correct ${keys} with a pipeline-config patch whose base is the value stored there (${stored}).`;
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
