import type { HealthKey } from "@/design/status";
import type { RunnerLine } from "@/features/project-dashboard/derive";
import { plural } from "@/features/project-dashboard/shape";

/** A box's state in words: busy and free are said only of a box online, as the dashboard counts them,
 *  and a busy one says how many live sessions it holds (ISS-1228). */
export function boxWord(line: RunnerLine, activityRead: boolean): string {
  const hosting = line.sessions > 0 ? ` · ${plural(line.sessions, "live session", "live sessions")}` : "";
  if (line.draining) return `Draining${hosting}`;
  if (!line.online) return `Offline${hosting}`;
  if (!activityRead) return "activity not read";
  return line.busy ? `Busy${hosting}` : "Free";
}

/** The dot beside that word; `stale` is whether the live session it hosts has gone quiet. */
export function boxHealth(line: RunnerLine, stale: boolean): HealthKey {
  if (line.online) return line.busy && stale ? "attention" : "healthy";
  return line.sessions > 0 ? "attention" : "idle";
}
