/**
 * Mirrors response from `GET /api/pipeline/throughput`.
 */
export interface ThroughputPoint {
  projectId: string;
  date: string; // ISO date 'YYYY-MM-DD'
  count: number;
}

/**
 * Mirrors response from `GET /api/pipeline/cycle-time`.
 */
export interface CycleTimePoint {
  status: string;
  avgHours: number;
  n: number;
}
