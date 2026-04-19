/**
 * Pikachu — Pipeline Orchestrator & Decision-Maker Agent
 *
 * Server-side AI agent that makes three types of decisions:
 *   1. Routing: dispatch/skip/hold/escalate before each pipeline skill
 *   2. Plan evaluation: approve/revise plans at "waiting" status
 *   3. Rejection evaluation: prioritize fixes, override minor findings at "reopen"
 *
 * Uses the existing agent runner (runAgent) with 6 internal tools.
 * Stores decisions in Qdrant for self-learning via RAG retrieval.
 * Falls back to hard-coded mapping on any error.
 */

import { runAgent } from './agent/runner';
import { createProvider } from './agent/provider';
import { postPipelineComment } from './pipeline-utils';
import type { ForgeTool, ForgeToolContext } from './agent/tools';
import type { ToolDefinition } from './agent/provider';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface PikachuDecision {
  action:
    | 'dispatch'
    | 'skip'
    | 'hold'
    | 'escalate'
    | 'approve_plan'
    | 'revise_plan'
    | 'dispatch_fix'
    | 'override_accept';
  skill?: string;
  reasoning: string;
  priority: 'high' | 'normal' | 'low';
  batch: boolean;
  advanceTo?: string;
  comment?: string;
  guidance?: string;
  revisionFeedback?: string;
  findingSummary?: {
    bugs: string[];
    minor: string[];
    low: string[];
    qaPasses: number;
    qaFails: number;
  };
  _sourceId?: string;
}

export interface PikachuContext {
  strapi: any;
  issueDocumentId: string;
  projectDocumentId: string;
  fromStatus: string;
  toStatus: string;
  reopenCount: number;
  queueDepth: number;
}

// ─── Skill mapping (used by fallback + LLM context) ─────────────────────────

const STATUS_SKILL_MAP: Record<string, string> = {
  open: 'forge-triage',
  confirmed: 'forge-plan',
  approved: 'forge-code',
  developed: 'forge-review',
  testing: 'forge-test',
  reopen: 'forge-fix',
};

// ─── Pikachu Tools ──────────────────────────────────────────────────────────

function createPikachuTools(ctx: PikachuContext): ForgeTool[] {
  const { strapi } = ctx;

  const getIssue: ForgeTool = {
    name: 'get_issue',
    description: 'Fetch issue details. Returns previews of long fields by default (description 300c, AC 200c, plan 300c). Set full=true to get complete content.',
    parameters: {
      type: 'object',
      properties: {
        documentId: { type: 'string', description: 'Issue documentId' },
        full: { type: 'boolean', description: 'Return full content for description, AC, and plan (default: false)' },
      },
      required: ['documentId'],
    },
    async execute(input) {
      const issue = await strapi.documents('api::issue.issue').findOne({
        documentId: input.documentId as string,
        populate: ['tasks'],
      });
      if (!issue) return 'Issue not found';
      const full = !!(input.full);
      const preview = (text: string | null, len: number) => {
        if (!text) return '';
        if (full || text.length <= len) return text;
        return text.slice(0, len) + '...';
      };
      return JSON.stringify({
        id: issue.id,
        documentId: issue.documentId,
        title: issue.title,
        description: preview(issue.description, 300),
        acceptanceCriteria: preview(issue.acceptanceCriteria, 200),
        plan: preview(issue.plan, 300),
        status: issue.status,
        priority: issue.priority,
        category: issue.category,
        descriptionLength: (issue.description || '').length,
        acLength: (issue.acceptanceCriteria || '').length,
        planLength: (issue.plan || '').length,
        taskCount: issue.tasks?.length ?? 0,
      });
    },
  };

  const getComments: ForgeTool = {
    name: 'get_comments',
    description: 'Read recent comments on an issue. Returns newest 5 comments with preview (300c). Set full=true for complete comment bodies, or limit for more comments.',
    parameters: {
      type: 'object',
      properties: {
        issueDocumentId: { type: 'string', description: 'Issue documentId' },
        full: { type: 'boolean', description: 'Return full comment bodies (default: false, returns 300c preview)' },
        limit: { type: 'number', description: 'Max comments to return (default 5, max 20)' },
      },
      required: ['issueDocumentId'],
    },
    async execute(input) {
      const reqLimit = Math.min(Math.max((input.limit as number) || 5, 1), 20);
      const full = !!(input.full);
      const comments = await strapi.documents('api::comment.comment').findMany({
        filters: { issue: { documentId: { $eq: input.issueDocumentId as string } } },
        sort: 'createdAt:desc',
        limit: reqLimit,
      });
      return JSON.stringify(
        comments.map((c: any) => {
          const body = c.body || '';
          return {
            author: c.author,
            body: full || body.length <= 300 ? body : body.slice(0, 300) + '...',
            bodyLength: body.length,
            createdAt: c.createdAt,
          };
        }),
      );
    },
  };

  const searchPastDecisions: ForgeTool = {
    name: 'search_past_decisions',
    description: 'Search past Pikachu decisions from knowledge base. Returns similar past decisions with their outcomes (success/failed) to inform current decision.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query describing the current situation' },
      },
      required: ['query'],
    },
    async execute(input) {
      try {
        const { searchSimilar } = await import('./embeddings/index');
        const results = await searchSimilar(
          ctx.projectDocumentId,
          input.query as string,
          5,
          ['pikachu_decision'],
        );
        if (results.length === 0) return 'No past decisions found.';
        return JSON.stringify(
          results.map((r) => ({
            score: r.score.toFixed(3),
            action: r.payload.metadata?.action,
            skill: r.payload.metadata?.skill,
            reasoning: r.payload.metadata?.reasoning,
            outcome: r.payload.metadata?.outcome || 'pending',
            fromStatus: r.payload.metadata?.fromStatus,
            toStatus: r.payload.metadata?.toStatus,
          })),
        );
      } catch {
        return 'Decision search unavailable.';
      }
    },
  };

  const evaluateFindings: ForgeTool = {
    name: 'evaluate_findings',
    description: 'Parse structured review or QA output into a severity breakdown. Pass the raw comment body from a review or QA report.',
    parameters: {
      type: 'object',
      properties: {
        commentBody: { type: 'string', description: 'Raw comment body containing review findings or QA table' },
      },
      required: ['commentBody'],
    },
    async execute(input) {
      const body = input.commentBody as string;
      const bugs: string[] = [];
      const minor: string[] = [];
      const low: string[] = [];
      let qaPasses = 0;
      let qaFails = 0;

      // Parse review severity table: | Severity | Description |
      const severityLines = body.match(/\|[^|]*\|[^|]*\|[^|]*\|/g) || [];
      for (const line of severityLines) {
        const lower = line.toLowerCase();
        if (lower.includes('---')) continue; // separator
        if (/\bbug\b/.test(lower)) bugs.push(line.replace(/\|/g, '').trim());
        else if (/\bminor\b/.test(lower)) minor.push(line.replace(/\|/g, '').trim());
        else if (/\blow\b/.test(lower)) low.push(line.replace(/\|/g, '').trim());
      }

      // Parse QA table: | # | Criterion | Status |
      const qaLines = body.match(/\|[^|]*\|[^|]*\|[^|]*pass[^|]*\|/gi) || [];
      qaPasses = qaLines.length;
      const qaFailLines = body.match(/\|[^|]*\|[^|]*\|[^|]*fail[^|]*\|/gi) || [];
      qaFails = qaFailLines.length;
      for (const line of qaFailLines) {
        bugs.push(line.replace(/\|/g, '').trim());
      }

      return JSON.stringify({ bugs, minor, low, qaPasses, qaFails });
    },
  };

  const submitDecision: ForgeTool = {
    name: 'submit_decision',
    description: 'Submit your routing decision. This is the final action — call this after gathering context. Actions: dispatch (run the skill), skip (advance status without running), hold (set on_hold), escalate (set needs_info).',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['dispatch', 'skip', 'hold', 'escalate'] },
        skill: { type: 'string', description: 'Which skill to dispatch (required for dispatch action)' },
        reasoning: { type: 'string', description: 'Brief explanation of your decision' },
        priority: { type: 'string', enum: ['high', 'normal', 'low'], description: 'Execution priority' },
        batch: { type: 'boolean', description: 'Whether to batch with related issues' },
        advanceTo: { type: 'string', description: 'Status to advance to (for skip action)' },
        guidance: { type: 'string', description: 'Optional guidance to prepend to skill prompt' },
      },
      required: ['action', 'reasoning'],
    },
    async execute(input) {
      return `Decision submitted: ${input.action} — ${input.reasoning}`;
    },
  };

  const submitEvaluation: ForgeTool = {
    name: 'submit_evaluation',
    description: 'Submit your evaluation decision for plan review or rejection analysis. Actions: approve_plan (plan is good, advance to approved), revise_plan (plan needs changes, post feedback), dispatch_fix (dispatch forge-fix with guidance on what to fix first), override_accept (findings are minor, accept and advance), hold (needs human review).',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['approve_plan', 'revise_plan', 'dispatch_fix', 'override_accept', 'hold'] },
        reasoning: { type: 'string', description: 'Brief explanation of your evaluation' },
        guidance: { type: 'string', description: 'For dispatch_fix: what to fix and in what order. For approve_plan: any notes for the coding step.' },
        revisionFeedback: { type: 'string', description: 'For revise_plan: specific feedback on what to change in the plan' },
      },
      required: ['action', 'reasoning'],
    },
    async execute(input) {
      return `Evaluation submitted: ${input.action} — ${input.reasoning}`;
    },
  };

  return [getIssue, getComments, searchPastDecisions, evaluateFindings, submitDecision, submitEvaluation];
}

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

function getDecisionType(toStatus: string): 'routing' | 'plan_eval' | 'rejection_eval' {
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

function buildUserMessage(ctx: PikachuContext, decisionType: string): string {
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

function extractDecision(
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

function validateAction(action: string): PikachuDecision['action'] {
  const valid = ['dispatch', 'skip', 'hold', 'escalate', 'approve_plan', 'revise_plan', 'dispatch_fix', 'override_accept'];
  return valid.includes(action) ? (action as PikachuDecision['action']) : 'dispatch';
}

function validatePriority(priority: string): 'high' | 'normal' | 'low' {
  if (priority === 'high' || priority === 'low') return priority;
  return 'normal';
}

// ─── Execute Non-Dispatch Decisions ─────────────────────────────────────────

const NEXT_STATUS: Record<string, string> = {
  open: 'confirmed',
  confirmed: 'approved',
  approved: 'in_progress',
  developed: 'deploying',
  testing: 'staging',
};

export async function executeDecision(
  strapi: any,
  decision: PikachuDecision,
  issueDocumentId: string,
  toStatus: string,
): Promise<void> {
  const commentAuthor = 'Pikachu';

  switch (decision.action) {
    case 'skip': {
      const advanceTo = decision.advanceTo || NEXT_STATUS[toStatus] || toStatus;
      await strapi.documents('api::issue.issue').update({
        documentId: issueDocumentId,
        data: { status: advanceTo } as any,
      });
      await postPipelineComment(strapi, issueDocumentId,
        `**Pipeline skip** — ${decision.reasoning}\n\nAdvanced to \`${advanceTo}\`.`,
        commentAuthor,
      );
      break;
    }

    case 'hold': {
      await strapi.documents('api::issue.issue').update({
        documentId: issueDocumentId,
        data: { manualHold: true } as any,
      });
      await postPipelineComment(strapi, issueDocumentId,
        `**Pipeline hold** — ${decision.reasoning}\n\nManual intervention required.`,
        commentAuthor,
      );
      break;
    }

    case 'escalate': {
      await strapi.documents('api::issue.issue').update({
        documentId: issueDocumentId,
        data: { status: 'needs_info' } as any,
      });
      await postPipelineComment(strapi, issueDocumentId,
        `**Needs info** — ${decision.reasoning}`,
        commentAuthor,
      );
      break;
    }

    case 'approve_plan': {
      await strapi.documents('api::issue.issue').update({
        documentId: issueDocumentId,
        data: { status: 'approved' } as any,
      });
      await postPipelineComment(strapi, issueDocumentId,
        `**Plan approved** — ${decision.reasoning}${decision.guidance ? `\n\n_Guidance for implementation:_ ${decision.guidance}` : ''}`,
        commentAuthor,
      );
      break;
    }

    case 'revise_plan': {
      await postPipelineComment(strapi, issueDocumentId,
        `**Plan revision needed** — ${decision.reasoning}\n\n${decision.revisionFeedback || 'Please review and update the plan.'}`,
        commentAuthor,
      );
      break;
    }

    case 'override_accept': {
      await strapi.documents('api::issue.issue').update({
        documentId: issueDocumentId,
        data: { status: 'developed' } as any,
      });
      await postPipelineComment(strapi, issueDocumentId,
        `**Findings overridden** — ${decision.reasoning}\n\nMinor/low-severity findings accepted. Advancing to developed.`,
        commentAuthor,
      );
      break;
    }

    // dispatch and dispatch_fix are handled by the orchestrator (returns to normal flow)
    default:
      break;
  }
}

// ─── Fallback (hard-coded mapping) ──────────────────────────────────────────

export function fallbackDecision(toStatus: string): PikachuDecision {
  // Plan evaluation fallback: auto-approve (don't block)
  if (toStatus === 'waiting') {
    return {
      action: 'approve_plan',
      reasoning: 'Fallback: auto-approving plan',
      priority: 'normal',
      batch: false,
    };
  }

  // Rejection evaluation fallback: dispatch fix (standard, no guidance)
  if (toStatus === 'reopen') {
    return {
      action: 'dispatch_fix',
      skill: 'forge-fix',
      reasoning: 'Fallback: dispatching fix',
      priority: 'normal',
      batch: false,
    };
  }

  // Standard routing fallback
  const skill = STATUS_SKILL_MAP[toStatus];
  if (skill) {
    return {
      action: 'dispatch',
      skill,
      reasoning: `Fallback: standard ${toStatus} → ${skill}`,
      priority: 'normal',
      batch: false,
    };
  }

  return {
    action: 'skip',
    reasoning: `Fallback: no skill mapped for ${toStatus}`,
    priority: 'normal',
    batch: false,
  };
}

// ─── Qdrant Storage ─────────────────────────────────────────────────────────

async function storePikachuDecision(
  _strapi: any,
  ctx: PikachuContext,
  decision: PikachuDecision,
  sourceId: string,
): Promise<void> {
  const { upsertEmbedding } = await import('./embeddings/index');

  const decisionType = getDecisionType(ctx.toStatus);
  const text = `${decision.action} ${decision.skill || ''} for issue ${ctx.issueDocumentId.slice(0, 8)} (${ctx.fromStatus}→${ctx.toStatus}): ${decision.reasoning}`;

  await upsertEmbedding({
    project_id: ctx.projectDocumentId,
    source_type: 'pikachu_decision',
    source_id: sourceId,
    text,
    metadata: {
      action: decision.action,
      skill: decision.skill,
      reasoning: decision.reasoning,
      outcome: null,
      decisionType,
      fromStatus: ctx.fromStatus,
      toStatus: ctx.toStatus,
      issueDocumentId: ctx.issueDocumentId,
      decisionAt: new Date().toISOString(),
    },
  });
}

// ─── Outcome Recording ──────────────────────────────────────────────────────

const COLLECTION_NAME = 'forge_embeddings';

export async function recordPikachuOutcome(
  strapi: any,
  sourceId: string,
  outcome: 'success' | 'failed',
  error?: string,
): Promise<void> {
  try {
    const { getQdrantClient } = await import('./embeddings/qdrant');
    const qdrant = getQdrantClient();
    if (!qdrant) return;

    // Find the point by source_id
    const scrollResult = await qdrant.scroll(COLLECTION_NAME, {
      filter: {
        must: [
          { key: 'source_type', match: { value: 'pikachu_decision' } },
          { key: 'source_id', match: { value: sourceId } },
        ],
      },
      limit: 1,
      with_payload: true,
    });

    const point = scrollResult.points[0];
    if (!point) return;

    // Merge outcome into existing metadata
    const metadata = (point.payload as any)?.metadata || {};
    metadata.outcome = outcome;
    if (error) metadata.outcomeError = error;
    metadata.outcomeAt = new Date().toISOString();

    await qdrant.setPayload(COLLECTION_NAME, {
      payload: { metadata },
      filter: {
        must: [
          { key: 'source_id', match: { value: sourceId } },
        ],
      },
    });

    strapi.log.debug(`[pikachu] Recorded outcome ${outcome} for ${sourceId}`);
  } catch (err: any) {
    strapi.log.debug(`[pikachu] Failed to record outcome: ${err.message}`);
  }
}
