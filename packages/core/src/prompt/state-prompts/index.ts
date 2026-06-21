/**
 * Built-in, per-state default system-prompt blocks (one file per state).
 *
 * Layered AFTER the shared preamble (Pipeline Rules / Tool Reference / Project
 * Config / Project Context) and BEFORE any project `states[state].systemPrompt`
 * override — see `prompt/system.ts`. Keyed by `JobType` (the step that runs at
 * each auto-dispatch state). Intermediate states with no step (deploying /
 * tested / staging) and non-pipeline steps (custom / pm) have no default block.
 *
 * Each block is platform-level POLICY for its state (objective + what to
 * emphasize + the exit/status contract) — short and stable. The detailed
 * procedure lives in the per-state skill. Improve one state by editing its file
 * without touching the others; projects can still override per state on top.
 */
import type { JobType } from '../../db/schema.js';
import { clarifyStatePrompt } from './clarify.js';
import { codeStatePrompt } from './code.js';
import { fixStatePrompt } from './fix.js';
import { planStatePrompt } from './plan.js';
import { releaseStatePrompt } from './release.js';
import { reviewStatePrompt } from './review.js';
import { testStatePrompt } from './test.js';
import { triageStatePrompt } from './triage.js';

/**
 * Shared obligation appended to consuming stages (plan/code/review/test/fix).
 * These stages receive prior handoffs that may carry open items; they must
 * address each before advancing. Re-query is available but prompt-layer only —
 * no server gate. clarify/triage/release intentionally excluded.
 */
const ADDRESS_INHERITED_OPEN_ITEMS = `

## Address inherited open items
If the Prior step handoffs block carries open items (clarify openQuestions, plan unknowns, code knownLimitations), address each before advancing: resolve it, or acknowledge with a reason in your comment/handoff. You may re-query the prior session for missing context (max 3 calls): \`forge_agent_sessions.list({ projectId, issueId })\` → pick the prior stage's session (match \`pipelineRunId\`) → \`forge_agent_sessions.get({ sessionId })\` (returns the last-20 message tail). Prompt-layer guidance, not a status gate.`;

const CONSUMES_OPEN_ITEMS: ReadonlySet<JobType> = new Set([
  'plan',
  'code',
  'review',
  'test',
  'fix',
]);

function withOpenItemsObligation(prompt: string, step: JobType): string {
  return CONSUMES_OPEN_ITEMS.has(step) ? prompt + ADDRESS_INHERITED_OPEN_ITEMS : prompt;
}

export const DEFAULT_STATE_SYSTEM_PROMPTS: Partial<Record<JobType, string>> = {
  triage: triageStatePrompt,
  clarify: clarifyStatePrompt,
  plan: withOpenItemsObligation(planStatePrompt, 'plan'),
  code: withOpenItemsObligation(codeStatePrompt, 'code'),
  review: withOpenItemsObligation(reviewStatePrompt, 'review'),
  test: withOpenItemsObligation(testStatePrompt, 'test'),
  fix: withOpenItemsObligation(fixStatePrompt, 'fix'),
  release: releaseStatePrompt,
};

/** Resolve the built-in state block for a step, or null when none applies. */
export function getStatePrompt(step: JobType | null | undefined): string | null {
  if (!step) return null;
  return DEFAULT_STATE_SYSTEM_PROMPTS[step] ?? null;
}

export { ADDRESS_INHERITED_OPEN_ITEMS, CONSUMES_OPEN_ITEMS };
