// The tools the composition root provides the chat assistant's allowlist (`assistant/tools/registry.ts`):
// read models and other modules' tools the assistant may not import. One list, so the boot and the
// test that every chat tool declares its permission (ISS-947) read the same tools.

import type { ChatToolSpec } from './assistant/index.js';
import { forgeNeedsYouTool } from './development/index.js';
import { forgeRecordingTool } from './feedback/index.js';
import { CHAT_READ_MODEL_TOOLS, CHAT_RECORD_TOOLS, CHAT_REPORT_TOOLS } from './mcp/index.js';
import { forgeStandingTool } from './standing/index.js';
import { forgeStewardNoteTool } from './steward-notes/index.js';

/**
 * The needs-me read (REQ-41 BC-1) is the development module's own tool, and the recording read
 * (BC-19) the feedback module's, wired here beside the read models.
 */
export const CHAT_PROVIDED_TOOLS: readonly ChatToolSpec[] = [
  ...CHAT_READ_MODEL_TOOLS,
  { factory: forgeNeedsYouTool },
  { factory: forgeRecordingTool },
  { factory: forgeStandingTool },
  { factory: forgeStewardNoteTool },
  ...CHAT_RECORD_TOOLS,
  ...CHAT_REPORT_TOOLS,
];
