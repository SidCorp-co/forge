// RFC 0002 INV-8 — the reopen ceiling is advice, not a gate.
//
// `REOPEN_CAP = 5` used to redirect a device actor's 6th reopen to `waiting`.
// The count it measured was wrong: on ISS-801 five rounds each fixed a
// DIFFERENT blocker, and a counter cannot tell that apart from five rounds that
// changed nothing. The number survives as orientation the agent reads and
// judges against; nothing here blocks a dispatch or writes a status.
//
// One number, two readers. The prompt prints it to the agent, and
// `alarmRejectionStreaks` measures it against CONSECUTIVE review rejections in
// one run. A third reader, `alarmChurningIssues`, measured it against TOTAL
// reopens — `reopen_count` only moves on entry into `reopen`, a transition this
// lane never performs, so ISS-895 deleted the pass rather than leave it frozen
// at 0. The wedge still names WHICH count fired, because that is what tells a
// reader whether the rounds were wasted.

export const DEFAULT_NO_PROGRESS_ROUNDS = 5;

// cm:guard nothing in core may branch on this value (RFC 0002 INV-8) — the moment a dispatch gate or a transition reads it, the deleted cap is back under a new name, and it will park the same progressing issues the cap parked
export function resolveNoProgressRounds(agentConfig: unknown): number {
  const cfg = agentConfig as
    | { pipelineConfig?: { reopenPolicy?: { noProgressRounds?: unknown } } }
    | null
    | undefined;
  const raw = cfg?.pipelineConfig?.reopenPolicy?.noProgressRounds;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1) {
    return DEFAULT_NO_PROGRESS_ROUNDS;
  }
  return raw;
}
