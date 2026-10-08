// The chat assistant's record tools, beside its read tools (`chat-read-tools.ts`): a different
// responsibility, so the modules each list reaches stay within the coordinator limit.

import { forgeFeedbackTool } from '../feedback/tool.js';
import type { ContextScopedMcpToolFactory } from '../lib/tool.js';
import { forgeRequirementDraftTool, forgeRequirementReviseTool } from '../requirements/tool.js';

/**
 * Where a chat door records what a person reports or wishes (owner ruling 2026-10-08): Feedback, a
 * draft Requirement or a draft revision of one. No chat door files an issue — the issue kernel
 * refuses a chat credential CHAT_FILES_FEEDBACK_NOT_ISSUES — so these are the only records it makes.
 * Not served on /mcp; the process entry hands them to the assistant's allowlist at boot.
 */
export const CHAT_RECORD_TOOLS: readonly { factory: ContextScopedMcpToolFactory }[] = [
  { factory: forgeFeedbackTool },
  { factory: forgeRequirementDraftTool },
  { factory: forgeRequirementReviseTool },
];
