/**
 * Dream Memory Consolidation — shared types and constants
 */

import type { MemoryRole, MemoryVisibility } from '../agent/memory';

// Strapi content-type UIDs
export const COMMENT_UID = 'api::comment.comment' as any;
export const ACTIVITY_UID = 'api::activity.activity' as any;
export const PROJECT_UID = 'api::project.project' as any;

// Concurrency guard — prevent overlapping dream runs per project
export const runningProjects = new Set<string>();

// Track last run time for the poller
export let lastPollTime = 0;
export function setLastPollTime(t: number) {
  lastPollTime = t;
}

export const POLL_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
export const CHECK_INTERVAL_MS = 60 * 60 * 1000; // Check every hour if it's time

// Pipeline skill comment prefixes that carry consolidation-worthy signal
export const SKILL_COMMENT_PREFIXES = ['**Triage**', '**Plan**', '**Review**', '**Test**', '**Fix**', '**Code**', '**Release**'];

// Max actions per run to prevent runaway changes
export const MAX_CREATES = 5;
export const MAX_UPDATES = 5;
export const MAX_PROMOTES = 3;
export const MAX_PRUNES = 10;
export const MAX_MEMORIES_FOR_PROMPT = 200;

// ─── Types ───────────────────────────────────────────────────────────────────

export interface DreamSignal {
  comments: { issueTitle: string; body: string; author: string }[];
  statusChanges: { issueTitle: string; from: string; to: string }[];
  reopenCycles: { issueTitle: string; comment: string }[];
}

export interface DreamActions {
  create: { content: string; role: MemoryRole; visibility: MemoryVisibility; category: string; scope: 'project' | 'global' }[];
  update: { sourceId: string; newContent: string }[];
  promote: { sourceId: string; newRole: MemoryRole; newVisibility: MemoryVisibility; content: string }[];
  prune: string[];
  summary: string;
}

export interface DreamResult {
  summary: string;
  actions: { created: number; updated: number; promoted: number; pruned: number };
}
