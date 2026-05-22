/**
 * Backwards-compatible re-export shim.
 *
 * The implementation moved to `core/src/prompt/user.ts` to consolidate all
 * prompt assembly behind a single SSOT (see PR-3 — `pipeline-prompt-ssot`).
 * Existing callers importing from `jobs/prompt-string.ts` continue to work.
 */
export {
  buildJobPromptString,
  type IssueField,
  type IssueSnapshot,
  type SessionContextField,
  type SessionContextSnapshot,
  type UserPromptPolicyOverride,
} from '../prompt/user.js';
