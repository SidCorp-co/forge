/**
 * Backwards-compatible re-export shim.
 *
 * The implementation moved to `core/src/prompt/system.ts` to consolidate all
 * prompt assembly behind a single SSOT (see PR-3 — `pipeline-prompt-ssot`).
 * Existing callers importing from `lib/chat-preamble.ts` continue to work.
 */
export {
  buildChatPreamble,
  buildPipelinePreamble,
  buildPipelinePreambleStructured,
  PIPELINE_RULES,
  TOOL_REFERENCE,
  type BuiltPreamble,
  type PreambleBlock,
  type PreambleBlockId,
  type SystemPromptOverride,
} from '../prompt/system.js';
