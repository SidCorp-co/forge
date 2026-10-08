
import type { NeedsYouProjectItem } from "@/features/needs-you/types";

export type AttentionKind = "mention" | "failed_job" | "runner_offline" | "channel_gate" | "status_report";

export interface AttentionItem {
  kind: AttentionKind;
  title: string;
  link: string;
  since: string;
  issueRef?: string;
  status?: string;
  projectSlug?: string;
  projectName?: string;
  questionId?: string | null;
  documentNumber?: string;
  /** Channel-gate only: the waiting document's type; null when core could not read it. */
  documentType?: string | null;
}

export interface AttentionResponse {
  /** Every project's needs-you rows, from core's one needs-you read model. */
  needsYou: NeedsYouProjectItem[];
  mentions: AttentionItem[];
  failedJobs: AttentionItem[];
  channelGates: AttentionItem[];
  /** Status reports sent to the caller that they have not opened, each linking to the kept report. */
  statusReports: AttentionItem[];
  total: number;
}

export interface AttentionView extends AttentionResponse {
  offlineRunners: AttentionItem[];
}
