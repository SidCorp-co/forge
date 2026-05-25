export interface BlockContributionRow {
  id: string;
  avgTokens: number;
  stddev: number;
  pctInput: number;
  cacheHitRate: number | null;
}

export interface BlockContributionResponse {
  step: string;
  runs: number;
  blocks: BlockContributionRow[];
}
