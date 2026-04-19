/**
 * Skill Pipeline Eval Service
 *
 * Traces issue pipeline paths from changeHistory, attributes successes/failures
 * to pipeline skills, and generates per-skill scorecards. Outputs dream-compatible
 * format for memory consolidation.
 */

// ─── Types ──────────────────────────────────────────────────────────────────────

interface PipelineStep {
  timestamp: string;
  actor: string;
  fromStatus: string;
  toStatus: string;
}

interface Rejection {
  rejectedSkill: string;
  catcherSkill: string;
  reason: string;
  fixedFirstTry: boolean;
  issueId: string;
  timestamp: string;
}

interface MissedDefect {
  missedBySkill: string;
  caughtBySkill: string;
  defectDescription: string;
  issueId: string;
}

interface SkillStats {
  totalRuns: number;
  passedFirstTime: number;
  passRate: number;
  rejections: { reason: string; count: number }[];
  missedDefects: MissedDefect[];
}

interface Scorecard {
  period: string;
  generatedAt: string;
  skills: Record<string, SkillStats>;
  topRejectionReasons: string[];
}

interface DreamInput {
  content: string;
  role: string;
  visibility: 'down' | 'same' | 'up';
  category: string;
}

// ─── Skill Mappings ─────────────────────────────────────────────────────────────

/** Maps pipeline skill name → the status(es) that skill produces. */
const SKILL_PRODUCES: Record<string, string[]> = {
  'forge-triage': ['confirmed', 'needs_info'],
  'forge-clarify': ['clarified', 'needs_info'],
  'forge-plan': ['approved', 'waiting'],
  'forge-code': ['developed', 'deploying'],
  'forge-review': ['deploying', 'testing', 'reopen'],
  'forge-test': ['staging', 'reopen'],
  'forge-fix': ['developed', 'deploying'],
  'forge-release': ['closed'],
};

/** Status → the skill that triggers at that status (from pipeline-orchestrator). */
const STATUS_TRIGGERS_SKILL: Record<string, string> = {
  open: 'forge-triage',
  confirmed: 'forge-clarify',
  clarified: 'forge-plan',
  approved: 'forge-code',
  developed: 'forge-review',
  testing: 'forge-test',
  reopen: 'forge-fix',
  released: 'forge-release',
};

/**
 * Reverse mapping: status → which skill SET that status.
 * Built from SKILL_PRODUCES. For statuses produced by multiple skills
 * (e.g. 'developed' by both forge-code and forge-fix), prefer the primary producer.
 */
const STATUS_SET_BY_SKILL: Record<string, string> = {};
for (const [skill, statuses] of Object.entries(SKILL_PRODUCES)) {
  for (const status of statuses) {
    // Don't overwrite — first entry wins (primary producer)
    if (!STATUS_SET_BY_SKILL[status]) {
      STATUS_SET_BY_SKILL[status] = skill;
    }
  }
}

/** The status before a reopen → which skill produced the rejected output. */
const PRE_REOPEN_SKILL: Record<string, string> = {
  developed: 'forge-code',
  deploying: 'forge-code',
  testing: 'forge-code',    // review approved but test caught it
};

// ─── Change History Parsing ─────────────────────────────────────────────────────

const CHANGE_HISTORY_RE = /\[(.+?)\] (.+?) changed status from "(.+?)" to "(.+?)"/;

/**
 * Reconstructs the full status flow from an issue's changeHistory.
 */
export function buildPipelinePath(changeHistory: string[]): PipelineStep[] {
  if (!Array.isArray(changeHistory)) return [];

  const steps: PipelineStep[] = [];
  for (const entry of changeHistory) {
    const match = CHANGE_HISTORY_RE.exec(entry);
    if (!match) continue;

    steps.push({
      timestamp: match[1],
      actor: match[2],
      fromStatus: match[3],
      toStatus: match[4],
    });
  }

  return steps;
}

// ─── Rejection Attribution ──────────────────────────────────────────────────────

/**
 * Maps each reopen in the pipeline path to the skill that produced the rejected
 * output and the skill that caught it.
 */
export function attributeRejections(
  path: PipelineStep[],
  comments: { body: string; author: string; createdAt: string }[],
  issueId: string,
): Rejection[] {
  const rejections: Rejection[] = [];

  for (let i = 0; i < path.length; i++) {
    const step = path[i];
    if (step.toStatus !== 'reopen') continue;

    // Which skill produced the rejected output?
    const rejectedSkill = PRE_REOPEN_SKILL[step.fromStatus] || STATUS_SET_BY_SKILL[step.fromStatus] || 'unknown';

    // Which skill caught the issue? The actor who set the reopen status.
    const catcherSkill = step.actor;

    // Find the reason from the closest comment before the reopen timestamp
    const reopenTime = new Date(step.timestamp).getTime();
    const reason = findClosestCommentReason(comments, reopenTime);

    // Was the fix successful on first try? Check if there's another reopen after the next developed
    const fixedFirstTry = !hasSubsequentReopen(path, i);

    rejections.push({
      rejectedSkill,
      catcherSkill,
      reason,
      fixedFirstTry,
      issueId,
      timestamp: step.timestamp,
    });
  }

  return rejections;
}

function findClosestCommentReason(
  comments: { body: string; author: string; createdAt: string }[],
  beforeTimestamp: number,
): string {
  let closest: { body: string; diff: number } | null = null;

  for (const comment of comments) {
    const commentTime = new Date(comment.createdAt).getTime();
    const diff = beforeTimestamp - commentTime;
    // Comment must be before the reopen, and within 1 hour
    if (diff >= 0 && diff < 3600000) {
      if (!closest || diff < closest.diff) {
        closest = { body: comment.body, diff };
      }
    }
  }

  if (!closest) return 'No reason found in comments';

  // Extract a summary — take first line or first 200 chars
  const body = closest.body.trim();
  const firstLine = body.split('\n')[0];
  return firstLine.length > 200 ? firstLine.slice(0, 200) + '...' : firstLine;
}

function hasSubsequentReopen(path: PipelineStep[], fromIndex: number): boolean {
  // After the current reopen, look for the next developed → then check if another reopen follows
  let foundDeveloped = false;
  for (let j = fromIndex + 1; j < path.length; j++) {
    if (path[j].toStatus === 'developed' || path[j].toStatus === 'deploying') {
      foundDeveloped = true;
    }
    if (foundDeveloped && path[j].toStatus === 'reopen') {
      return true;
    }
  }
  return false;
}

// ─── Missed Defect Detection ────────────────────────────────────────────────────

/**
 * Finds cases where an upstream skill approved but a downstream skill caught bugs.
 * Pattern 1: review approved (→ testing) but test reopened → review missed defect
 * Pattern 2: test passed (→ pass) but later reopened → test coverage gap
 */
export function detectMissedDefects(
  path: PipelineStep[],
  comments: { body: string; author: string; createdAt: string }[],
  issueId: string,
): MissedDefect[] {
  const defects: MissedDefect[] = [];

  for (let i = 0; i < path.length; i++) {
    const step = path[i];

    // Pattern 1: review approved (testing) → later reopened by test
    if (step.toStatus === 'testing') {
      const nextReopen = findNextReopen(path, i);
      if (nextReopen && nextReopen.fromStatus === 'testing') {
        const reopenTime = new Date(nextReopen.timestamp).getTime();
        const reason = findClosestCommentReason(comments, reopenTime);
        defects.push({
          missedBySkill: 'forge-review',
          caughtBySkill: 'forge-test',
          defectDescription: reason,
          issueId,
        });
      }
    }

    // Pattern 2: test passed (pass) → later reopened from staging-related status
    if (step.toStatus === 'staging') {
      const nextReopen = findNextReopen(path, i);
      if (nextReopen && nextReopen.fromStatus === 'staging') {
        const reopenTime = new Date(nextReopen.timestamp).getTime();
        const reason = findClosestCommentReason(comments, reopenTime);
        defects.push({
          missedBySkill: 'forge-test',
          caughtBySkill: 'staging',
          defectDescription: reason,
          issueId,
        });
      }
    }
  }

  return defects;
}

/** Forward-progression statuses that indicate the upstream step's output was accepted. */
const ACCEPTED_STATUSES = new Set(['staging', 'released', 'closed']);

function findNextReopen(path: PipelineStep[], fromIndex: number): PipelineStep | null {
  for (let j = fromIndex + 1; j < path.length; j++) {
    if (path[j].toStatus === 'reopen') return path[j];
    // If the issue progressed past this stage, the upstream step succeeded
    if (ACCEPTED_STATUSES.has(path[j].toStatus)) return null;
  }
  return null;
}

// ─── Scorecard Generation ───────────────────────────────────────────────────────

const ISSUE_UID = 'api::issue.issue' as any;
const SKILL_EVAL_UID = 'api::skill-eval.skill-eval' as any;

/** All pipeline skills to track. */
const ALL_SKILLS = [
  'forge-triage', 'forge-clarify', 'forge-plan', 'forge-code',
  'forge-review', 'forge-test', 'forge-fix', 'forge-release',
];

function periodToDate(period: string): Date {
  const now = new Date();
  const days = period === 'd90' ? 90 : period === 'd30' ? 30 : 7;
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

/**
 * Generates a per-skill scorecard for a project over a configurable period.
 */
export async function generateScorecard(
  strapi: any,
  projectDocId: string,
  period: 'd7' | 'd30' | 'd90' = 'd7',
): Promise<Scorecard> {
  const since = periodToDate(period);

  const issues = await strapi.documents(ISSUE_UID).findMany({
    filters: {
      project: { documentId: projectDocId },
      updatedAt: { $gte: since.toISOString() },
    },
    populate: ['comments'],
    limit: 500,
  });

  // Initialize stats for all skills
  const skillStats: Record<string, {
    totalRuns: number;
    passedFirstTime: number;
    rejectionReasons: string[];
    missedDefects: MissedDefect[];
  }> = {};

  for (const skill of ALL_SKILLS) {
    skillStats[skill] = { totalRuns: 0, passedFirstTime: 0, rejectionReasons: [], missedDefects: [] };
  }

  const allRejections: Rejection[] = [];

  for (const issue of issues) {
    const path = buildPipelinePath(issue.changeHistory || []);
    if (path.length === 0) continue;

    const comments = (issue.comments || []).map((c: any) => ({
      body: c.body || '',
      author: c.author || '',
      createdAt: c.createdAt || '',
    }));

    // Count each skill execution (not deduplicated — a skill that runs twice counts twice)
    const skillRunCounts: Record<string, number> = {};
    for (const step of path) {
      const skill = STATUS_TRIGGERS_SKILL[step.fromStatus];
      if (skill) {
        skillRunCounts[skill] = (skillRunCounts[skill] || 0) + 1;
      }
    }

    // Get rejections and missed defects
    const rejections = attributeRejections(path, comments, issue.issueId || issue.documentId);
    const missedDefects = detectMissedDefects(path, comments, issue.issueId || issue.documentId);

    allRejections.push(...rejections);

    // Count rejections per skill on this issue
    const rejectionCountBySkill: Record<string, number> = {};
    for (const r of rejections) {
      rejectionCountBySkill[r.rejectedSkill] = (rejectionCountBySkill[r.rejectedSkill] || 0) + 1;
    }

    for (const [skill, runCount] of Object.entries(skillRunCounts)) {
      if (!skillStats[skill]) continue;
      skillStats[skill].totalRuns += runCount;
      const rejectCount = rejectionCountBySkill[skill] || 0;
      skillStats[skill].passedFirstTime += (runCount - rejectCount);
    }

    // Attribute rejection reasons
    for (const r of rejections) {
      if (skillStats[r.rejectedSkill]) {
        skillStats[r.rejectedSkill].rejectionReasons.push(r.reason);
      }
    }

    // Attribute missed defects
    for (const d of missedDefects) {
      if (skillStats[d.missedBySkill]) {
        skillStats[d.missedBySkill].missedDefects.push(d);
      }
    }
  }

  // Build final scorecard
  const skills: Record<string, SkillStats> = {};

  for (const [skill, stats] of Object.entries(skillStats)) {
    if (stats.totalRuns === 0) continue;

    // Group rejection reasons by similarity (exact match for now)
    const reasonCounts: Record<string, number> = {};
    for (const reason of stats.rejectionReasons) {
      reasonCounts[reason] = (reasonCounts[reason] || 0) + 1;
    }

    skills[skill] = {
      totalRuns: stats.totalRuns,
      passedFirstTime: stats.passedFirstTime,
      passRate: Math.round((stats.passedFirstTime / stats.totalRuns) * 100) / 100,
      rejections: Object.entries(reasonCounts)
        .map(([reason, count]) => ({ reason, count }))
        .sort((a, b) => b.count - a.count),
      missedDefects: stats.missedDefects,
    };
  }

  // Top rejection reasons across all skills
  const globalReasonCounts: Record<string, number> = {};
  for (const r of allRejections) {
    globalReasonCounts[r.reason] = (globalReasonCounts[r.reason] || 0) + 1;
  }
  const topRejectionReasons = Object.entries(globalReasonCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([reason]) => reason);

  return {
    period,
    generatedAt: new Date().toISOString(),
    skills,
    topRejectionReasons,
  };
}

// ─── Dream Integration ──────────────────────────────────────────────────────────

/** Skill → role mapping for dream memory creation. */
const SKILL_ROLE: Record<string, string> = {
  'forge-code': 'dev',
  'forge-fix': 'dev',
  'forge-review': 'techlead',
  'forge-test': 'qa',
  'forge-plan': 'techlead',
  'forge-triage': 'triage',
  'forge-clarify': 'qa',
};

/**
 * Formats scorecard results as dream-compatible memory suggestions.
 * Does NOT write to Qdrant — the dream service consumes this output.
 */
export function formatForDream(scorecard: Scorecard): DreamInput[] {
  const inputs: DreamInput[] = [];

  for (const [skill, stats] of Object.entries(scorecard.skills)) {
    // Only generate dream inputs for underperforming skills
    if (stats.passRate >= 0.9 && stats.missedDefects.length === 0) continue;

    const role = SKILL_ROLE[skill] || 'techlead';

    // Group rejection reasons into actionable memory
    if (stats.rejections.length > 0) {
      const reasonList = stats.rejections
        .slice(0, 5)
        .map((r) => `${r.reason} (${r.count}x)`)
        .join('; ');

      inputs.push({
        content: `${skill} has a ${Math.round(stats.passRate * 100)}% first-pass rate (${scorecard.period}). Top rejection reasons: ${reasonList}`,
        role,
        visibility: 'down',
        category: 'convention',
      });
    }

    // Generate checklist items from missed defects
    for (const defect of stats.missedDefects) {
      inputs.push({
        content: `${defect.missedBySkill} missed a defect caught by ${defect.caughtBySkill}: ${defect.defectDescription}`,
        role,
        visibility: 'same',
        category: 'checklist',
      });
    }
  }

  return inputs;
}
