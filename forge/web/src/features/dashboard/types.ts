export interface ProjectHealth {
  projectName: string;
  projectSlug: string;
  projectMeta: Record<string, unknown>;
  throughput: number;
  totalActive: number;
  statusDistribution: Record<string, number>;
  blockers: Array<{
    issueId: string;
    documentId: string;
    status: string;
  }>;
  pendingEscalations: number;
  avgCycleTimeDays: number;
}
