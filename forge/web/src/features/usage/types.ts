export interface UsageRecord {
  id: string;
  projectId: string | null;
  source: 'cli' | 'api' | 'desktop';
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  estimatedCost: number;
  requestCount: number;
  sessionId?: string | null;
  projectName?: string | null;
  recordedAt: string;
  createdAt: string;
  // Legacy alias.
  documentId?: string;
}

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  estimatedCost: number;
  requests: number;
}

export interface DailyUsage {
  date: string;
  input: number;
  output: number;
  cost: number;
  requests: number;
}

export interface ModelUsage {
  model: string;
  input: number;
  output: number;
  cost: number;
  requests: number;
}

export interface SourceUsage {
  source: string;
  input: number;
  output: number;
  cost: number;
  requests: number;
}

export interface UsageSummary {
  totals: UsageTotals;
  daily: DailyUsage[];
  byModel: ModelUsage[];
  bySource: SourceUsage[];
}
