import type { IssueStatus } from '../../db/schema.js';
import { CANONICAL_LADDER } from './registry.js';

/** The one key of a stage's config this rule reads; the stage schema carries more and none of it is a sequence. */
export interface LadderStageConfig {
  enabled?: boolean;
}

export function effectivePipelineStates(
  states: Record<string, LadderStageConfig | undefined> | null | undefined,
): IssueStatus[] {
  const configured = states ?? {};
  return CANONICAL_LADDER.filter((stage) => configured[stage]?.enabled !== false);
}
