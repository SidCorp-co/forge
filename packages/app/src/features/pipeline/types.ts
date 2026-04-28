export type PipelineFilter = 'active' | 'all';

export interface PipelineSession {
  documentId: string;
  title: string;
  status: 'idle' | 'queued' | 'running' | 'completed' | 'failed';
  createdAt: string;
  updatedAt: string;
  metadata: {
    type?: string;
    skill?: string;
    runner?: string;
    fromStatus?: string;
    toStatus?: string;
    retryCount?: number;
    deviceId?: string;
    deviceName?: string;
    noResume?: boolean;
  } | null;
  project: { id: number; documentId: string; name: string; slug: string } | null;
  issues: Array<{ id: number; documentId: string; title: string; status: string }>;
}
