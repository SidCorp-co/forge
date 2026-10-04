import { enumLabel } from "@/design/vocabulary";
import type { FireProduced, FireStanding } from "./types";

/** Why a fire ended where it did: its refusal, its error, or why it ran nothing. */
export function fireWhy(f: Pick<FireStanding, "refusal" | "error" | "reason">): string | null {
  if (f.refusal) return f.refusal;
  if (f.error) return f.error;
  return f.reason ? enumLabel("fireSkipReason", f.reason) : null;
}

export function fmtDuration(seconds: number | null): string {
  if (seconds == null) return "—";
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

const PRODUCED: Array<[keyof Omit<FireProduced, "newReports">, string]> = [
  ["reports", "report"],
  ["proposals", "proposal"],
  ["issues", "issue"],
  ["runs", "run"],
  ["notifications", "notification"],
];

export function producedLine(p: FireProduced): string {
  const parts = PRODUCED.filter(([k]) => p[k] > 0).map(([k, noun]) => `${p[k]} ${noun}${p[k] === 1 ? "" : "s"}`);
  if (parts.length === 0) return "Nothing produced";
  return p.newReports > 0 ? `${parts.join(" · ")} · ${p.newReports} new` : parts.join(" · ");
}

export const shortId = (id: string) => id.slice(0, 8);

export function fmtTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
