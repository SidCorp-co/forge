// The chat assistant's read tools, apart from the /mcp registry (`registry.ts`): a different door
// with a different reader, and the modules each list reaches stay within the coordinator limit.

import { forgeDecisionsTool } from '../comments/tool.js';
import type { ContextScopedMcpToolFactory } from '../lib/tool.js';
import {
  forgeMetricsProjectStepDurationsTool,
  forgeMetricsProjectTimeseriesTool,
} from '../metrics/tool.js';
import { forgeProjectStatusTool } from '../project-status/tool.js';
import { forgeReleasesTool, forgeReleaseTool } from '../release-batch/tool.js';
import { forgeRequirementsTool, forgeRequirementTool } from '../requirements/tool.js';

/**
 * The chat assistant's tools over read models it may not import (ADR 0008); not served on /mcp.
 * The process entry hands them to the assistant's allowlist at boot. Status, requirement, release
 * and decision questions are answered from the first six, and the reply screen refuses such an
 * answer that none of them grounded (`messaging/grounding-rule.ts`, JU-1).
 */
export const CHAT_READ_MODEL_TOOLS: readonly { factory: ContextScopedMcpToolFactory }[] = [
  { factory: forgeProjectStatusTool },
  { factory: forgeRequirementsTool },
  { factory: forgeRequirementTool },
  { factory: forgeReleasesTool },
  { factory: forgeReleaseTool },
  { factory: forgeDecisionsTool },
  { factory: forgeMetricsProjectStepDurationsTool },
  { factory: forgeMetricsProjectTimeseriesTool },
];
