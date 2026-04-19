/**
 * Dream Memory Consolidation — signal gathering and helpers
 */

import type { MemoryEntry } from '../agent/memory';
import { createActivity } from '../../lifecycles/issue-lifecycle';
import {
  COMMENT_UID,
  ACTIVITY_UID,
  SKILL_COMMENT_PREFIXES,
  type DreamSignal,
  type DreamResult,
} from './types';

// ─── Phase 2: Gather Signal ──────────────────────────────────────────────────

export async function gatherDreamSignal(
  strapi: any,
  projectDocId: string,
  since: Date,
): Promise<DreamSignal> {
  const sinceISO = since.toISOString();

  // Query recent AI comments with their issues
  const comments = await strapi.documents(COMMENT_UID).findMany({
    filters: {
      issue: { project: { documentId: projectDocId } },
      createdAt: { $gte: sinceISO },
      isAI: true,
    },
    populate: { issue: { fields: ['title', 'status'] } },
    fields: ['body', 'author', 'createdAt'],
    pagination: { pageSize: 100 },
  });

  // Filter to pipeline skill comments
  const skillComments = (comments ?? [])
    .filter((c: any) => {
      const body: string = c.body || '';
      return SKILL_COMMENT_PREFIXES.some((prefix) => body.startsWith(prefix));
    })
    .map((c: any) => ({
      issueTitle: c.issue?.title || 'Unknown',
      body: (c.body || '').slice(0, 500),
      author: c.author || 'AI',
    }));

  // Query recent status changes
  const activities = await strapi.documents(ACTIVITY_UID).findMany({
    filters: {
      issue: { project: { documentId: projectDocId } },
      type: 'status_change',
      createdAt: { $gte: sinceISO },
    },
    populate: { issue: { fields: ['title', 'status'] } },
    fields: ['fromValue', 'toValue', 'actor'],
    pagination: { pageSize: 200 },
  });

  const statusChanges = (activities ?? []).map((a: any) => ({
    issueTitle: a.issue?.title || 'Unknown',
    from: a.fromValue || '',
    to: a.toValue || '',
  }));

  // Identify reopen cycles — highest-value learning signal
  const reopenChanges = statusChanges.filter((sc) => sc.to === 'reopen');
  const reopenCycles: DreamSignal['reopenCycles'] = [];

  for (const rc of reopenChanges) {
    // Find the fix/review comment for the reopened issue
    const fixComment = skillComments.find(
      (c) => c.issueTitle === rc.issueTitle && (c.body.startsWith('**Fix**') || c.body.startsWith('**Review**')),
    );
    reopenCycles.push({
      issueTitle: rc.issueTitle,
      comment: fixComment?.body || 'No fix comment found',
    });
  }

  return { comments: skillComments, statusChanges, reopenCycles };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

export function groupMemoriesByRole(memories: MemoryEntry[]): string {
  const groups: Record<string, MemoryEntry[]> = {};
  for (const m of memories) {
    const role = m.role || 'untagged';
    if (!groups[role]) groups[role] = [];
    groups[role].push(m);
  }

  return Object.entries(groups)
    .map(([role, mems]) => {
      const lines = mems.map((m) => `  - [${m.sourceId}] [${m.category}] ${m.content} (retrievals: ${m.retrievalCount})`);
      return `### ${role} (${mems.length})\n${lines.join('\n')}`;
    })
    .join('\n\n');
}

export async function logDreamActivity(strapi: any, projectDocId: string, result: DreamResult): Promise<void> {
  // Find any issue in the project to attach the activity to (use most recently updated)
  try {
    const issues = await strapi.documents('api::issue.issue' as any).findMany({
      filters: { project: { documentId: projectDocId } },
      fields: ['documentId'],
      sort: { updatedAt: 'desc' },
      pagination: { pageSize: 1 },
    });

    if (issues?.length > 0) {
      await createActivity(strapi, {
        type: 'enriched',
        issue: issues[0].documentId,
        actor: 'Dream',
        body: `Memory consolidation: ${result.summary} (created: ${result.actions.created}, updated: ${result.actions.updated}, promoted: ${result.actions.promoted}, pruned: ${result.actions.pruned})`,
        isAI: true,
      });
    }
  } catch (err) {
    strapi.log.warn(`[dream] Failed to log activity: ${err}`);
  }
}
