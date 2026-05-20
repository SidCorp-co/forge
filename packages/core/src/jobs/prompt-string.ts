import type { IssueStatus, JobType } from '../db/schema.js';

export interface IssueSnapshot {
  title: string;
  status: IssueStatus;
  priority: string;
  complexity: string | null;
  description: string | null;
  plan: string | null;
  acceptanceCriteria: string | null;
}

interface FieldRule {
  description: boolean;
  plan: boolean;
  acceptanceCriteria: boolean;
}

const FIELD_RULES: Record<JobType, FieldRule> = {
  triage: { description: true, plan: false, acceptanceCriteria: false },
  clarify: { description: true, plan: false, acceptanceCriteria: true },
  plan: { description: true, plan: false, acceptanceCriteria: true },
  code: { description: true, plan: true, acceptanceCriteria: true },
  review: { description: false, plan: true, acceptanceCriteria: true },
  test: { description: false, plan: false, acceptanceCriteria: true },
  release: { description: false, plan: false, acceptanceCriteria: false },
  fix: { description: true, plan: true, acceptanceCriteria: true },
  custom: { description: false, plan: false, acceptanceCriteria: false },
  pm: { description: false, plan: false, acceptanceCriteria: false },
};

const DESCRIPTION_CAP = 8000;
const PLAN_CAP = 16000;
const ACCEPTANCE_CAP = 4000;

function clamp(value: string, cap: number): string {
  if (value.length <= cap) return value;
  return `${value.slice(0, cap)}\n… [truncated]`;
}

function nonEmpty(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? value : null;
}

/**
 * SSOT for the runner-facing prompt string. Stamped at every issue-bound
 * job insert site (orchestrator, PM dispatch, escalation fallback) and
 * forwarded verbatim to the runner via the `job.assigned` WS event.
 *
 * When `issueSnapshot` is provided, the prompt grows a `## Issue` block so
 * the agent has title / description / plan / AC inline and can skip the
 * first `forge_issues.get` MCP round-trip. The block lives on the user
 * side so the system prompt cache is unaffected. The per-state include
 * matrix follows pipeline-workflow.html §7.
 */
export function buildJobPromptString(args: {
  skillName?: string | null;
  jobType: JobType;
  issueId: string;
  issueSnapshot?: IssueSnapshot;
}): string {
  const skill =
    args.skillName && args.skillName.length > 0 ? args.skillName : `forge-${args.jobType}`;
  const head = `/${skill} ${args.issueId}`;
  if (!args.issueSnapshot) return head;

  const snap = args.issueSnapshot;
  const rule = FIELD_RULES[args.jobType];

  const lines: string[] = ['', '## Issue', `Title: ${snap.title}`];
  lines.push(
    `Status: ${snap.status} · Priority: ${snap.priority} · Complexity: ${snap.complexity ?? 'unknown'}`,
  );

  if (rule.description) {
    const desc = nonEmpty(snap.description);
    if (desc) {
      lines.push('', 'Description:', clamp(desc, DESCRIPTION_CAP));
    }
  }
  if (rule.plan) {
    const plan = nonEmpty(snap.plan);
    if (plan) {
      lines.push('', 'Plan:', clamp(plan, PLAN_CAP));
    }
  }
  if (rule.acceptanceCriteria) {
    const ac = nonEmpty(snap.acceptanceCriteria);
    if (ac) {
      lines.push('', 'Acceptance:', clamp(ac, ACCEPTANCE_CAP));
    }
  }

  return `${head}\n${lines.join('\n')}`;
}
