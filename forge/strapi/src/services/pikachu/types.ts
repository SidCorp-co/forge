/**
 * Pikachu types — Pipeline Orchestrator & Decision-Maker Agent
 */

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

export const STATUS_SKILL_MAP: Record<string, string> = {
  open: 'forge-triage',
  confirmed: 'forge-plan',
  approved: 'forge-code',
  developed: 'forge-review',
  testing: 'forge-test',
  reopen: 'forge-fix',
};
