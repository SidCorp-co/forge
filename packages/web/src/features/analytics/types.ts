export interface CostSummaryByState {
  state: string;
  total: number;
  runs: number;
  avgPerRun: number;
}

export interface CostSummaryByIssue {
  issueId: string;
  total: number;
}

export interface CostSummary {
  total: number;
  byState: CostSummaryByState[];
  byIssue: CostSummaryByIssue[];
}

export interface CostTrendDaily {
  date: string;
  cost: number;
  runs: number;
}

export interface CostTrendAnnotation {
  ts: string;
  message: string;
  kind: 'pipeline_config.updated';
}

export interface CostTrend {
  daily: CostTrendDaily[];
  annotations: CostTrendAnnotation[];
}

export interface OutlierDimensions {
  descriptionLen: number;
  sessionDepth: number;
}

export interface OutlierRun {
  jobId: string;
  state: string;
  cost: number;
  issueId: string | null;
  dimensions: OutlierDimensions;
}

export interface Outliers {
  threshold: number;
  runs: OutlierRun[];
}
