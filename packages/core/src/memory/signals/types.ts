export interface CandidateSignal {
  signalType: string;
  signalKey: string;
  summary: string;
  evidence: { runId: string; issueId: string; at: string };
}
