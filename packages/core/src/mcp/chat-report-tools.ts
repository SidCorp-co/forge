// The chat assistant's report tools, beside its read and record tools: forge_report runs a registered
// query and keeps the run, forge_show draws one of its blocks into the room, forge_template runs a
// report template, and forge_compute runs a script over the turn's runs on a sandbox executor.
// Composed into the assistant's allowlist by the process entry, so no assistant file names a query,
// a block, a template or an executor.

import type { ContextScopedMcpToolFactory } from '../lib/tool.js';
import {
  forgeComputeTool,
  forgeReportTool,
  forgeShowTool,
  forgeTemplateTool,
} from '../reports/tool.js';

/** Not served on /mcp: an agent session runs a query, posts a block and runs a computation over REST. */
export const CHAT_REPORT_TOOLS: readonly { factory: ContextScopedMcpToolFactory }[] = [
  { factory: forgeReportTool },
  { factory: forgeShowTool },
  { factory: forgeTemplateTool },
  { factory: forgeComputeTool },
];
