export interface ChatLog {
  id: number;
  documentId: string;
  sessionId: string;
  projectSlug: string;
  userKey: string | null;
  query: string;
  reply: string | null;
  model: string | null;
  usage: { input_tokens?: number; output_tokens?: number } | null;
  iterations: number;
  durationMs: number | null;
  error: string | null;
  source: string;
  qaRating: 'good' | 'bad' | 'flagged' | null;
  createdAt: string;
  updatedAt: string;
}

export interface ChatLogFilters {
  projectSlug?: string;
  source?: string;
  qaRating?: string;
  dateFrom?: string;
  dateTo?: string;
  page?: number;
  pageSize?: number;
}

export interface ChatLogListResponse {
  data: ChatLog[];
  meta: {
    pagination: {
      page: number;
      pageSize: number;
      pageCount: number;
      total: number;
    };
  };
}
