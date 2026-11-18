// The capabilities page's reading of a project's doors (ISS-1251 §7): where each door stands, the
// agent kinds that called it read as the audiences a card teaches, and its reports and lessons beside
// it. A door no agent called over the window is never neutral: it stands "unused", which the page reads
// as teach better, redesign or delete (design §5).

import type { CapabilitiesView, CapabilityFeedbackRow, CapabilityFreshnessRow, CapabilityLessonRow } from "@forge/contracts/capabilities";
import type { DoorUseRow, PileRow } from "@forge/contracts/door-use";
import type { LegendTone } from "@/design";

/**
 * Where a door stands, the order the page lists them in: what asks for a decision first. A card owing
 * a re-check stands there whether or not it was called, so the count says every card that owes one.
 */
export const CAP_STANDINGS = ["recheck", "unused", "misused", "untaught", "inUse"] as const;
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

/**
 * Who called, as the audiences a card teaches. A box credential's call counts under the session it was
 * made in where core could name one (ISS-1251); one it could not stays the box's, master's and runs'
 * alike, so it reads as the box and never as a run.
 */
export const CAP_CALLERS = ["bot", "master", "run", "box", "other"] as const;
export type CapCaller = (typeof CAP_CALLERS)[number];

export function callerOf(agent: string): CapCaller {
  if (agent.startsWith("room:")) return "bot";
  if (agent === "session:master") return "master";
  if (agent === "session:run_session" || agent === "session:pipeline") return "run";
  if (agent === "box" || agent === "checkout") return "box";
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
  freshness: CapabilityFreshnessRow | null;
}

/**
 * Where a door stands. A re-check owed reads first and from core's one record of it, the card's
 * freshness, which a module tree's capability node reads too (`labels/module-map-read.ts`), so this
 * page and the trees count the same doors (ISS-1256, L-91): ranked under "unused", or widened by a
 * lesson's own flag, it counted 3 where the trees counted 1.
 */
export function standingOf(row: DoorUseRow, feedback: CapabilityFeedbackRow | null, _lessons: readonly CapabilityLessonRow[], freshness: CapabilityFreshnessRow | null = null): CapStanding {
  if (freshness?.recheckOwed) return "recheck";
  if (row.calls === 0) return "unused";
  if (row.refused * MISUSE_SHARE >= row.calls || (feedback?.reports ?? 0) > 0) return "misused";
  if (!row.card) return "untaught";
  return "inUse";
}

/**
 * Every door joined with its reports and card lessons, each read where it stands. A card's freshness
 * and lessons are keyed by its card id, which a door named otherwise (`project_feedback.submit`, card
 * `POST /api/projects/:id/feedback`) does not share, so they are read by the card's id.
 */
export function capDoorsOf(doors: readonly DoorUseRow[], extra: CapabilitiesView | undefined): CapDoor[] {
  const feedback = new Map((extra?.feedback ?? []).map((f) => [f.door, f]));
  const fresh = new Map((extra?.freshness ?? []).map((f) => [f.card, f]));
  const lessons = new Map<string, CapabilityLessonRow[]>();
  for (const l of extra?.lessons ?? []) lessons.set(l.card, [...(lessons.get(l.card) ?? []), l]);
  return doors.map((row) => {
    const cardId = row.card?.id ?? row.door;
    const f = feedback.get(row.door) ?? null;
    const ls = lessons.get(cardId) ?? [];
    const fr = fresh.get(cardId) ?? null;
    return { row, standing: standingOf(row, f, ls, fr), feedback: f, lessons: ls, freshness: fr };
  });
}

export function standingCounts(doors: readonly CapDoor[]): Record<CapStanding, number> {
  const out = Object.fromEntries(CAP_STANDINGS.map((s) => [s, 0])) as Record<CapStanding, number>;
  for (const d of doors) out[d.standing] += 1;
  return out;
}

/**
 * What a door is called on the page: its card's purpose, else the door as an agent knows it
 * (`support.requirements`, a route), never a fragment of its guide's text.
 */
export function doorTitle(row: DoorUseRow): { text: string; mono: boolean } {
  return row.card ? { text: row.card.purpose, mono: false } : { text: row.name, mono: true };
}

/**
 * Who read, as a Read row names it: a pipeline's job session apart from a run a master declared,
 * which the callers' count both reads as a run, so no two rows carry one label.
 */
export function readerLabelKey(agent: string): "modules.cap.reader.pipeline" | `modules.cap.caller.${CapCaller}` {
  return agent === "session:pipeline" ? "modules.cap.reader.pipeline" : `modules.cap.caller.${callerOf(agent)}`;
}

/** Who named a door missed or applied a lesson, read as the callers the page counts. */
export function agentLabelKey(agent: string): "modules.cap.agent" | `modules.cap.caller.${Exclude<CapCaller, "other"> | "person"}` {
  if (agent === "person") return "modules.cap.caller.person";
  const caller = callerOf(agent);
  return caller === "other" ? "modules.cap.agent" : `modules.cap.caller.${caller}`;
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
