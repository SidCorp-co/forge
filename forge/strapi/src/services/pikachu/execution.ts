/**
 * Pikachu execution — execute non-dispatch decisions and fallback logic
 */

import { postPipelineComment } from '../pipeline-utils';
import type { PikachuDecision } from './types';
import { STATUS_SKILL_MAP } from './types';

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
