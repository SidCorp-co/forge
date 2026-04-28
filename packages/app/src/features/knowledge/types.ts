export interface KnowledgeIndex {
  project?: string;
  architecture?: string;
  paths?: Record<string, string>;
  domains?: Record<string, string[]>;
  conventions?: Record<string, string>;
  recipes?: Record<string, string>;
  commands?: Record<string, string>;
}

export interface KnowledgeEdge {
  documentId: string;
  subject: string;
  predicate: string;
  object: string;
  value?: string;
  confidence?: number;
}
