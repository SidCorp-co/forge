/* The seven staged job types, as colour and label.
   NOT a ladder. There is no order here and no progression: ISS-897 deleted the staged lane from
   the kernel, and ISS-999 deleted the last places that drew a position on it. What survives is a
   vocabulary — when a REAL step (a `jobs` row's `jobType`) happens to be one of these seven names,
   this is the colour and the word it reads in. ~30k historical rows carry them, so a client still
   has to render one.
   A job type that is not one of these seven — `drive`, which is the only job type an autonomous
   run has — is rendered under its own name by whoever renders it. It is not folded onto a
   neighbour and it does not resolve to `triage`: `stageColor` answers a neutral token and the
   caller shows the name the kernel recorded. */

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

// cm:guard takes a plain job-type string and NOT a StageKey, because the answer for a name outside the seven is the point: it is the neutral token, never a seven's colour by fallback. ISS-999 deleted STAGE_INDEX from this file for the same reason — an index is an order, and an order over these names is the ladder the kernel does not have.
export function stageColor(key: string): string {
  return STAGES.find((s) => s.key === key)?.color ?? "var(--fg-subtle)";
}
