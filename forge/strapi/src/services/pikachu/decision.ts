/**
 * Pikachu decision logic — decide, extract, validate, build messages
 */

import { runAgent } from '../agent/runner';
import { createProvider } from '../agent/provider';
import type { ForgeToolContext } from '../agent/tools';
import type { ToolDefinition } from '../agent/provider';
import type { PikachuDecision, PikachuContext } from './types';
import { STATUS_SKILL_MAP } from './types';
import { createPikachuTools } from './tools';
import { fallbackDecision } from './execution';
import { storePikachuDecision } from './storage';

// ─── System Prompt ──────────────────────────────────────────────────────────

const PIKACHU_SYSTEM_PROMPT = `You are Pikachu, the pipeline orchestrator and decision authority for a software project management system.

Your job is to make intelligent decisions about how issues should flow through the development pipeline. You have three types of decisions:

## Decision Type 1: Routing (statuses: open, confirmed, approved, developed, testing)
Choose one action:
- **dispatch**: Run the mapped skill for this status transition
- **skip**: Advance the status without running a skill (e.g., issue already triaged)
- **hold**: Put the issue on hold — needs human attention
- **escalate**: Set to needs_info — missing critical information

Available skills:
- forge-triage (open→confirmed): Validate completeness, classify complexity, set category/priority
- forge-plan (confirmed→waiting/approved): Write implementation plan
- forge-code (approved→developed): Implement the plan
- forge-review (developed→deploying): Independent code review
- forge-test (testing→staging): QA against acceptance criteria
- forge-fix (reopen→developed): Scoped fixes from review/QA rejection

Call submit_decision with your routing choice.

## Decision Type 2: Plan Evaluation (status: waiting)
The plan has been written and needs evaluation before coding begins.
- Call get_issue to read the plan field
- Check: Does the plan cover all acceptance criteria? Are risks identified? Is the approach sound?
- **approve_plan**: Plan is comprehensive → advance to approved
- **revise_plan**: Plan has gaps → post revision feedback, stay at waiting
- **hold**: Too risky or complex for automated decision

Call submit_evaluation with your evaluation choice.

## Decision Type 3: Rejection Evaluation (status: reopen)
An issue was rejected by review or QA. Analyze the findings to guide the fix.
- Call get_comments to read the review/QA feedback
- Call evaluate_findings to parse severity breakdown
- **dispatch_fix**: Send to forge-fix with guidance on what to fix (prioritize Bug-severity issues)
- **override_accept**: Only Minor/Low findings — accept and advance past reopen
- **hold**: Mixed critical findings needing human triage

When dispatching a fix, always include guidance explaining WHAT to fix and in WHAT order.
Call submit_evaluation with your evaluation choice.

## Rules
1. Always call search_past_decisions before making your final decision — learn from past outcomes
2. Be concise in reasoning — 1-2 sentences max
3. Default to dispatch unless there's a clear reason not to
4. For routing: simple status transitions (e.g., approved→forge-code) should be fast — don't over-analyze
5. For plan evaluation: approve unless the plan is clearly incomplete or risky
6. For rejection evaluation: if only Minor/Low severity findings, prefer override_accept
7. Always end by calling submit_decision OR submit_evaluation — never end without one`;

// ─── Decide ─────────────────────────────────────────────────────────────────

export function getDecisionType(toStatus: string): 'routing' | 'plan_eval' | 'rejection_eval' {
  if (toStatus === 'waiting') return 'plan_eval';
  if (toStatus === 'reopen') return 'rejection_eval';
  return 'routing';
}

export async function decide(ctx: PikachuContext): Promise<PikachuDecision> {
  const { strapi, issueDocumentId, toStatus, fromStatus } = ctx;
  const log = strapi.log;

  const apiUrl = process.env.LITELLM_API_URL;
  const apiKey = process.env.LITELLM_API_KEY || '';
  if (!apiUrl) {
    log.debug('[pikachu] No LITELLM_API_URL, using fallback');
    return fallbackDecision(toStatus);
  }

  const decisionType = getDecisionType(toStatus);
  const model = process.env.PIKACHU_MODEL || process.env.LITELLM_FAST_MODEL || 'gemini-flash';

  try {
    const provider = await createProvider(apiKey, apiUrl);
    const tools = createPikachuTools(ctx);
    const toolDefs: ToolDefinition[] = tools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));

    const userMessage = buildUserMessage(ctx, decisionType);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);

    const toolContext: ForgeToolContext = {
      strapi,
      projectDocumentId: ctx.projectDocumentId,
      signal: controller.signal,
    };

    log.info(`[pikachu] ISS-? ${fromStatus}→${toStatus}: deciding (${decisionType}, model=${model})`);

    const result = await runAgent({
      provider,
      model,
      messages: [{ role: 'user', content: userMessage }],
      tools,
      toolDefinitions: toolDefs,
      systemPrompt: PIKACHU_SYSTEM_PROMPT,
      toolContext,
      signal: controller.signal,
      maxIterations: 3,
    });

    clearTimeout(timeout);

    // Extract decision from tool calls
    const decision = extractDecision(result.toolCalls, decisionType, toStatus);

    log.info(
      `[pikachu] Decision: ${decision.action} ${decision.skill || ''} — ${decision.reasoning} (${result.iterations} iters, ${result.usage.inputTokens}+${result.usage.outputTokens} tokens)`,
    );

    // Store in Qdrant (fire-and-forget)
    const sourceId = `pika_${issueDocumentId.slice(0, 8)}_${toStatus}_${Date.now()}`;
    decision._sourceId = sourceId;
    storePikachuDecision(strapi, ctx, decision, sourceId).catch((err) =>
      log.debug(`[pikachu] Failed to store decision: ${err.message}`),
    );

    return decision;
  } catch (err: any) {
    log.warn(`[pikachu] Error: ${err.message}, using fallback`);
    return fallbackDecision(toStatus);
  }
}

export function buildUserMessage(ctx: PikachuContext, decisionType: string): string {
  const parts = [
    `Pipeline event: ${ctx.fromStatus} → ${ctx.toStatus}`,
    `Issue: ${ctx.issueDocumentId}`,
    `Decision type: ${decisionType}`,
  ];
  if (ctx.reopenCount > 0) parts.push(`Reopen count: ${ctx.reopenCount}`);
  if (ctx.queueDepth > 0) parts.push(`Queue depth: ${ctx.queueDepth}`);
  parts.push('', 'Make your decision.');
  return parts.join('\n');
}

export function extractDecision(
  toolCalls: Array<{ name: string; input: Record<string, unknown> }>,
  _decisionType: string,
  toStatus: string,
): PikachuDecision {
  // Look for submit_evaluation first (for plan_eval and rejection_eval)
  const evalCall = toolCalls.find((tc) => tc.name === 'submit_evaluation');
  if (evalCall) {
    const input = evalCall.input;
    return {
      action: validateAction(input.action as string),
      skill: input.action === 'dispatch_fix' ? 'forge-fix' : undefined,
      reasoning: (input.reasoning as string) || 'No reasoning provided',
      priority: 'normal',
      batch: false,
      guidance: input.guidance as string | undefined,
      revisionFeedback: input.revisionFeedback as string | undefined,
    };
  }

  // Look for submit_decision (routing)
  const decisionCall = toolCalls.find((tc) => tc.name === 'submit_decision');
  if (decisionCall) {
    const input = decisionCall.input;
    return {
      action: validateAction(input.action as string),
      skill: (input.skill as string) || STATUS_SKILL_MAP[toStatus],
      reasoning: (input.reasoning as string) || 'No reasoning provided',
      priority: validatePriority(input.priority as string),
      batch: !!(input.batch),
      advanceTo: input.advanceTo as string | undefined,
      guidance: input.guidance as string | undefined,
    };
  }

  // No decision tool called — fallback
  return fallbackDecision(toStatus);
}

export function validateAction(action: string): PikachuDecision['action'] {
  const valid = ['dispatch', 'skip', 'hold', 'escalate', 'approve_plan', 'revise_plan', 'dispatch_fix', 'override_accept'];
  return valid.includes(action) ? (action as PikachuDecision['action']) : 'dispatch';
}

export function validatePriority(priority: string): 'high' | 'normal' | 'low' {
  if (priority === 'high' || priority === 'low') return priority;
  return 'normal';
}
