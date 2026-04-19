/**
 * Memory types, interfaces, and role-based visibility.
 */

export type MemoryRole = 'ceo' | 'cto' | 'pm' | 'po' | 'techlead' | 'dev' | 'qa' | 'devops';
export type MemoryVisibility = 'down' | 'same' | 'up' | 'all';

// Ordered from highest to lowest authority
const ROLE_HIERARCHY: MemoryRole[] = ['ceo', 'cto', 'pm', 'po', 'techlead', 'dev', 'qa', 'devops'];

// Which roles' memories each pipeline skill can read
export const SKILL_MEMORY_ROLES: Record<string, MemoryRole[]> = {
  'forge-triage':   ['ceo', 'pm'],
  'forge-clarify':  ['ceo', 'techlead', 'qa'],
  'forge-plan':     ['ceo', 'cto', 'techlead'],
  'forge-code':     ['cto', 'techlead'],
  'forge-review':   ['cto', 'techlead'],
  'forge-test':     ['ceo', 'techlead', 'qa'],
  'forge-fix':      ['techlead'],
  'forge-release':  ['ceo', 'devops'],
  'po-review':      ['ceo', 'pm'],
};

/**
 * Check if a memory is visible to a reader based on visibility rules.
 */
export function isVisibleTo(
  writerRole: MemoryRole,
  visibility: MemoryVisibility,
  readerRoles: MemoryRole[],
): boolean {
  if (visibility === 'all') return true;

  const writerIdx = ROLE_HIERARCHY.indexOf(writerRole);
  if (writerIdx === -1) return true;

  for (const readerRole of readerRoles) {
    const readerIdx = ROLE_HIERARCHY.indexOf(readerRole);
    if (readerIdx === -1) continue;

    if (visibility === 'same' && readerRole === writerRole) return true;
    if (visibility === 'down' && readerIdx > writerIdx) return true;
    if (visibility === 'up' && readerIdx < writerIdx) return true;
  }
  return false;
}

export interface MemoryEntry {
  sourceId: string;
  category: string;
  content: string;
  scope: string;
  source: string;
  userKey: string;
  retrievalCount: number;
  role: string;
  visibility: string;
  createdAt: string;
  updatedAt: string;
}

export interface SearchMemoriesOptions {
  limit?: number;
  allowedRoles?: MemoryRole[];
  includeGlobal?: boolean;
  strategy?: 'semantic' | 'keyword' | 'graph' | 'hybrid' | 'auto';
}

export interface SearchMemoryEntry extends MemoryEntry {
  score: number;
}

export interface ListMemoriesOptions {
  /** Roles whose memories to include (from SKILL_MEMORY_ROLES) */
  allowedRoles?: MemoryRole[];
  /** Include global-scoped memories */
  includeGlobal?: boolean;
}

// Map Forge categories to Claude Code memory types
export const CATEGORY_TO_TYPE: Record<string, string> = {
  preference: 'feedback',
  correction: 'feedback',
  convention: 'project',
  tool_pattern: 'reference',
};
