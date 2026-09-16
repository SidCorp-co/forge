/** ISS-1064 — the ground the memory-note gate tests stand on: one framed ask and a passing input. */

import { judgeNote, type NoteJudgeInput } from './memory-note-gate.js';

export const REMEMBER = 'Remember for this project: the release code name is bench-1a2b3c4d5e6f.';
export const base = (over: Partial<NoteJudgeInput> = {}): NoteJudgeInput => ({
  text: 'The release code name is bench-1a2b3c4d5e6f.',
  recentTurns: [REMEMBER],
  notesThisTurn: 0,
  existingNotes: [],
  ...over,
});
export const code = (input: NoteJudgeInput) => judgeNote(input)?.code ?? null;
