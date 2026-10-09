export const phaseJournalSources = ['runner', 'agent', 'system'] as const;
export type PhaseJournalSource = (typeof phaseJournalSources)[number];

export const phaseJournalOutcomes = ['ok', 'failed', 'abandoned'] as const;
export type PhaseJournalOutcome = (typeof phaseJournalOutcomes)[number];
