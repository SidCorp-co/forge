// The chat assistant's report tools, beside its read and record tools: forge_report runs a registered
// query and keeps the run, forge_show draws one of its blocks into the room. Composed into the
// assistant's allowlist by the process entry, so no assistant file names a query or a block.

import type { ContextScopedMcpToolFactory } from '../lib/tool.js';
import { forgeReportTool, forgeShowTool } from '../reports/tool.js';

/** Not served on /mcp: an agent session runs a query and posts a block over REST. */
export const CHAT_REPORT_TOOLS: readonly { factory: ContextScopedMcpToolFactory }[] = [
  { factory: forgeReportTool },
  { factory: forgeShowTool },
];
