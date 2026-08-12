/**
 * Backwards-compatible re-export shim.
 *
 * The implementation moved to `core/src/prompt/system.ts` to consolidate all
 * prompt assembly behind a single SSOT (see PR-3 — `pipeline-prompt-ssot`).
 * Existing callers importing from `lib/chat-preamble.ts` continue to work.
 */
export {
  type BuiltPreamble,
  buildChatPreamble,
  buildPipelinePreamble,
  buildPipelinePreambleStructured,
  PIPELINE_RULES,
  type PreambleBlock,
  type PreambleBlockId,
  type SystemPromptOverride,
  TOOL_REFERENCE,
} from '../prompt/system.js';
