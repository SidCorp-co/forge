export const DEFAULT_NO_PROGRESS_ROUNDS = 5;

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
