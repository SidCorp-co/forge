/* The 7-stage pipeline — the product's hero motif.
   triage → clarify → plan → code → review → test → release */

export const STAGES = [
  { key: "triage", label: "triage", color: "var(--stage-triage)", desc: "Intake & label" },
  { key: "clarify", label: "clarify", color: "var(--stage-clarify)", desc: "Resolve ambiguity" },
  { key: "plan", label: "plan", color: "var(--stage-plan)", desc: "Break into tasks" },
  { key: "code", label: "code", color: "var(--stage-code)", desc: "Implement" },
  { key: "review", label: "review", color: "var(--stage-review)", desc: "Self-review diff" },
  { key: "test", label: "test", color: "var(--stage-test)", desc: "Run the suite" },
  { key: "release", label: "release", color: "var(--stage-release)", desc: "Open PR / ship" },
] as const;

export type StageKey = (typeof STAGES)[number]["key"];

export const STAGE_INDEX: Record<StageKey, number> = Object.fromEntries(
  STAGES.map((s, i) => [s.key, i]),
) as Record<StageKey, number>;

export function stageColor(key: StageKey): string {
  return STAGES.find((s) => s.key === key)?.color ?? "var(--fg-subtle)";
}
