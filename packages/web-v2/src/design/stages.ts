
// each pipeline stage's colour; its word is the jobType label (`enumLabel("jobType", key)`)
export const STAGES = [
  { key: "triage", color: "var(--stage-triage)" },
  { key: "clarify", color: "var(--stage-clarify)" },
  { key: "plan", color: "var(--stage-plan)" },
  { key: "code", color: "var(--stage-code)" },
  { key: "review", color: "var(--stage-review)" },
  { key: "test", color: "var(--stage-test)" },
  { key: "release", color: "var(--stage-release)" },
] as const;

export type StageKey = (typeof STAGES)[number]["key"];

export function stageColor(key: string): string {
  return STAGES.find((s) => s.key === key)?.color ?? "var(--fg-subtle)";
}
