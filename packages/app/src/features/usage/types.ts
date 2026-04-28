export interface UsageRecord {
  id: number;
  documentId: string;
  source: 'cli' | 'api' | 'desktop';
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  estimatedCost: number;
  requestCount: number;
  sessionId?: string;
  projectName?: string;
  recordedAt: string;
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
