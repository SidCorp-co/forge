/**
 * Pikachu tools — Internal tools for the decision-maker agent
 */

import type { ForgeTool } from '../agent/tools';
import type { PikachuContext } from './types';

// ─── Pikachu Tools ──────────────────────────────────────────────────────────

export function createPikachuTools(ctx: PikachuContext): ForgeTool[] {
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
        const { searchSimilar } = await import('../embeddings/index');
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
