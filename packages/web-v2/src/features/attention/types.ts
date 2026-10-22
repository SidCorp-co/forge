
import type { NeedsYouProjectDecisions } from "@forge/contracts/needs-you-decisions";

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
  /** Each project's Needs you `total` and its first decisions, from core's one decisions read (REQ-48 BC-11). */
  needsYou: NeedsYouProjectDecisions[];
  mentions: AttentionItem[];
  failedJobs: AttentionItem[];
  channelGates: AttentionItem[];
  /** Status reports sent to the caller that they have not opened, each linking to the kept report. */
  statusReports: AttentionItem[];
  /** The decisions waiting on you across your projects: the sum of their Needs you `total`s, core's own (REQ-48 r3 BC-17). */
  waitingOnYou: number;
  total: number;
}

export interface AttentionView extends AttentionResponse {
  offlineRunners: AttentionItem[];
}
