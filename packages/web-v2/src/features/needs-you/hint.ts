import type { NeedsYouArea } from "./types";

/** The tooltip under a count: what the rows wait on the viewer to do, as core named each act. */
export function needsYouHint(label: string, area: NeedsYouArea): string {
  if (area.you === 0) return `${label} · nothing waits on you`;
  const acts = area.acts.map((a) => (a.count > 1 ? `${a.act || "act"} (${a.count})` : a.act || "act"));
  return `${label} · waiting on you ${area.you}: ${acts.join(", ")}`;
}
