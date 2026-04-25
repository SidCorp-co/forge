export interface KnowledgeEdge {
  id: string;
  projectId: string;
  subject: string;
  predicate: string;
  object: string;
  value: string | null;
  sourceMemoryId: string | null;
  confidence: number;
  validFrom: string | null;
  validUntil: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgeEdgeInput {
  projectId: string;
  subject: string;
  predicate: string;
  object: string;
  value?: string | null;
  confidence?: number;
}

export interface KnowledgeIngestDocument {
  id: string;
  title: string;
  content: string;
  category?: string | null;
  metadata?: Record<string, unknown>;
}

export interface KnowledgeIngestResult {
  ok: boolean;
  processed: number;
  totalChunks: number;
  skipped: Array<{ id: string; reason: string }>;
}
