export type MemoryCategory = 'preference' | 'correction' | 'convention' | 'tool_pattern';
export type MemoryRole = 'ceo' | 'cto' | 'pm' | 'po' | 'techlead' | 'dev' | 'qa' | 'devops';
export type MemoryVisibility = 'down' | 'same' | 'up' | 'all';

export interface Memory {
  documentId: string;
  category: MemoryCategory;
  content: string;
  scope: 'user' | 'project' | 'global';
  source: 'auto' | 'manual';
  role?: MemoryRole | null;
  visibility?: MemoryVisibility | null;
  retrievalCount: number;
  createdAt: string;
  updatedAt: string;
}
