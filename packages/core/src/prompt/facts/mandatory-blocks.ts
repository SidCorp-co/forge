import type { JobType } from '../../db/schema.js';
import { DRIVE_RULES_TEXT, DRIVE_TOOL_REFERENCE_TEXT } from './drive-rules.js';
import { renderFact } from './registry.js';

export const PIPELINE_RULES = renderFact('pipeline-rules') ?? '';

export const TOOL_REFERENCE = renderFact('mcp-tool-reference') ?? '';

export function mandatoryPreambleBlocks(step: JobType | null): {
  pipelineRules: string;
  toolReference: string;
} {
  return step === 'drive'
    ? { pipelineRules: DRIVE_RULES_TEXT, toolReference: DRIVE_TOOL_REFERENCE_TEXT }
    : { pipelineRules: PIPELINE_RULES, toolReference: TOOL_REFERENCE };
}
