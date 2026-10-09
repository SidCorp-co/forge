/**
 * Who wrote the row. `agent` narrates its own progress over REST; `system` is
 * core deriving a row from kernel state it observed itself. `runner` stays in
 * the enum because rows carrying it exist; nothing writes it any more.
 */
export const phaseJournalSources = ['runner', 'agent', 'system'] as const;
export type PhaseJournalSource = (typeof phaseJournalSources)[number];

export const phaseJournalOutcomes = ['ok', 'failed', 'abandoned'] as const;
export type PhaseJournalOutcome = (typeof phaseJournalOutcomes)[number];
