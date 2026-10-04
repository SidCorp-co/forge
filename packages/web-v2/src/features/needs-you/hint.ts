import { AUTOMATION_ACT_LABELS } from "@forge/contracts/automation-standing";
import type { NeedsYouArea } from "./types";

const actLabel = (act: string): string =>
  (AUTOMATION_ACT_LABELS as Record<string, string | undefined>)[act] ?? (act || "act");

export function needsYouHint(label: string, area: NeedsYouArea): string {
  if (area.you === 0) return `${label} · nothing waits on you`;
  const acts = area.acts.map((a) => (a.count > 1 ? `${actLabel(a.act)} (${a.count})` : actLabel(a.act)));
  return `${label} · waiting on you ${area.you}: ${acts.join(", ")}`;
}
