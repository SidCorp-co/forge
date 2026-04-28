import type { IssueStatus, JobType } from '../db/schema.js';

export interface SkillMapping {
  type: JobType;
  toggle: string;
}

/**
 * Authoritative status → skill + toggle map. Source: docs/modules/issues-pipeline/status-pipeline.md.
 * Statuses not listed here are human-gated (waiting, staging, on_hold, needs_info, …) and never enqueue.
 */
export const STATUS_TO_SKILL: Partial<Record<IssueStatus, SkillMapping>> = {
  open: { type: 'triage', toggle: 'autoTriage' },
  confirmed: { type: 'plan', toggle: 'autoPlan' },
  approved: { type: 'code', toggle: 'autoCode' },
  developed: { type: 'review', toggle: 'autoReview' },
  testing: { type: 'test', toggle: 'autoTest' },
  reopen: { type: 'fix', toggle: 'autoFix' },
  released: { type: 'release', toggle: 'autoRelease' },
};

export function resolveSkillForStatus(status: IssueStatus): SkillMapping | null {
  return STATUS_TO_SKILL[status] ?? null;
}
