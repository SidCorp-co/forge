// The capabilities page's reading of a project's doors (ISS-1251 §7): where each door stands, the
// agent kinds that called it read as the audiences a card teaches, and its reports and lessons beside
// it. A door no agent called over the window is never neutral: it stands "unused", which the page reads
// as teach better, redesign or delete (design §5).

import type { CapabilitiesView, CapabilityFeedbackRow, CapabilityLessonRow } from "@forge/contracts/capabilities";
import type { DoorUseRow, PileRow } from "@forge/contracts/door-use";
import type { LegendTone } from "@/design";

/** Where a door stands, the order the page lists them in: what asks for a decision first. */
export const CAP_STANDINGS = ["unused", "recheck", "misused", "untaught", "inUse"] as const;
export type CapStanding = (typeof CAP_STANDINGS)[number];

export const CAP_STANDING_TONE: Record<CapStanding, LegendTone> = {
  unused: "you",
  recheck: "blocked",
  misused: "err",
  untaught: "neutral",
  inUse: "ready",
};

/** A door refused on a quarter of its calls or more is used badly. */
const MISUSE_SHARE = 4;

/** Who called, as the audiences a card teaches; a box credential is shared by its master and its runs. */
export const CAP_CALLERS = ["bot", "master", "run", "box", "other"] as const;
export type CapCaller = (typeof CAP_CALLERS)[number];

export function callerOf(agent: string): CapCaller {
  if (agent.startsWith("room:")) return "bot";
  if (agent === "session:master") return "master";
  if (agent === "checkout" || agent === "session:run_session" || agent === "session:pipeline") return "run";
  if (agent === "box") return "box";
  return "other";
}

/** A door's calls by caller, every caller present with 0 where none called. */
export function callsByCaller(byAgent: Record<string, number>): Record<CapCaller, number> {
  const out = Object.fromEntries(CAP_CALLERS.map((c) => [c, 0])) as Record<CapCaller, number>;
  for (const [agent, n] of Object.entries(byAgent)) out[callerOf(agent)] += n;
  return out;
}

/** One door with what the page reads beside it. */
export interface CapDoor {
  row: DoorUseRow;
  standing: CapStanding;
  feedback: CapabilityFeedbackRow | null;
  lessons: CapabilityLessonRow[];
}

export function standingOf(row: DoorUseRow, feedback: CapabilityFeedbackRow | null, lessons: readonly CapabilityLessonRow[]): CapStanding {
  if (row.calls === 0) return "unused";
  if (lessons.some((l) => l.invalid)) return "recheck";
  if (row.refused * MISUSE_SHARE >= row.calls || (feedback?.reports ?? 0) > 0) return "misused";
  if (!row.card) return "untaught";
  return "inUse";
}

/** Every door joined with its reports and card lessons, each read where it stands. */
export function capDoorsOf(doors: readonly DoorUseRow[], extra: CapabilitiesView | undefined): CapDoor[] {
  const feedback = new Map((extra?.feedback ?? []).map((f) => [f.door, f]));
  const lessons = new Map<string, CapabilityLessonRow[]>();
  for (const l of extra?.lessons ?? []) lessons.set(l.card, [...(lessons.get(l.card) ?? []), l]);
  return doors.map((row) => {
    const f = feedback.get(row.door) ?? null;
    const ls = lessons.get(row.door) ?? [];
    return { row, standing: standingOf(row, f, ls), feedback: f, lessons: ls };
  });
}

export function standingCounts(doors: readonly CapDoor[]): Record<CapStanding, number> {
  const out = Object.fromEntries(CAP_STANDINGS.map((s) => [s, 0])) as Record<CapStanding, number>;
  for (const d of doors) out[d.standing] += 1;
  return out;
}

/** What a door is called on the page: its card's purpose, its guide's line, else its route. */
export function doorTitle(row: DoorUseRow): { text: string; mono: boolean } {
  const text = row.card?.purpose ?? row.summary;
  return text ? { text, mono: false } : { text: row.door, mono: true };
}

/** A refusal code as words: `SUPPORT_ACT_DENIED` reads "Support act denied", `not_found` "Not found". */
export function codeWords(code: string): string {
  const words = code.replace(/[_.:-]+/g, " ").trim().toLowerCase();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : code;
}

/** The piles a page lists first, then each skill's always-on part. */
export function pilesOf(piles: readonly PileRow[]): { prompt: PileRow[]; skills: PileRow[] } {
  return { prompt: piles.filter((p) => p.pile !== "skill_always_on"), skills: piles.filter((p) => p.pile === "skill_always_on") };
}
