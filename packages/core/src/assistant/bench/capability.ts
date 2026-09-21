import type { TaskSide } from './compare.js';
import type { Tally } from './judge.js';
import { CAPABILITIES, type Capability } from './task.js';

export interface Lowest {
  id: string;
  passK: number | null;
}

export interface CapabilitySummary {
  capability: Capability;
  /** The task ids walked under this capability, in run order; a not-applicable task is not one of them. */
  tasks: string[];
  /** Tasks this project cannot supply a fixture for, each with its reason; charged to no denominator (ISS-1066). */
  notApplicable: Array<{ id: string; why: string }>;
  /** Mean of pass^k over the tasks with one, 0–100 to one decimal; null where none has one. */
  score: number | null;
  lowest: Lowest | null;
  /** Tasks whose pass^k is 1. */
  fullTasks: number;
  judge: Tally | null;
}

export interface SidedTask {
  id: string;
  capability: Capability;
  side: TaskSide;
  /** Why the project cannot supply one of this task's fixtures; such a task is reported, never scored. */
  notApplicable?: string;
}

/** The mean of pass^k over the sides that have one, 0–100 to one decimal, with the lowest task. */
export function passKMean(sides: Array<{ id: string; side: TaskSide }>): {
  score: number | null;
  lowest: Lowest | null;
} {
  const withK = sides.filter((s) => s.side.passK !== null);
  if (withK.length === 0) return { score: null, lowest: null };
  const mean = withK.reduce((sum, s) => sum + (s.side.passK ?? 0), 0) / withK.length;
  const lowest = [...withK].sort(
    (a, b) => (a.side.passK ?? 0) - (b.side.passK ?? 0) || a.id.localeCompare(b.id),
  )[0];
  return {
    score: Math.round(mean * 1000) / 10,
    lowest: lowest ? { id: lowest.id, passK: lowest.side.passK } : null,
  };
}

const sumTally = (tallies: Tally[]): Tally | null => {
  if (tallies.length === 0) return null;
  const out: Tally = { judged: 0, yes: 0, partial: 0, no: 0, unreadable: 0 };
  for (const t of tallies) {
    out.judged += t.judged;
    out.yes += t.yes;
    out.partial += t.partial;
    out.no += t.no;
    out.unreadable += t.unreadable;
  }
  return out;
};

/** One summary per capability at least one task carries, in the order `CAPABILITIES` names them. */
export function summarizeCapabilities(tasks: SidedTask[]): CapabilitySummary[] {
  return CAPABILITIES.flatMap((capability) => {
    const all = tasks.filter((t) => t.capability === capability);
    if (all.length === 0) return [];
    const own = all.filter((t) => t.notApplicable === undefined);
    const { score, lowest } = passKMean(own);
    return [
      {
        capability,
        tasks: own.map((t) => t.id),
        notApplicable: all.flatMap((t) =>
          t.notApplicable ? [{ id: t.id, why: t.notApplicable }] : [],
        ),
        score,
        lowest,
        fullTasks: own.filter((t) => t.side.passK === 1).length,
        judge: sumTally(own.flatMap((t) => (t.side.judge ? [t.side.judge] : []))),
      },
    ];
  });
}

const num = (v: number | null): string => (v === null ? '—' : v.toFixed(1));

/** One line per capability for a terminal, the score beside the tasks that made it, then any this project cannot be asked. */
export function capabilityLines(summaries: CapabilitySummary[]): string[] {
  return summaries.flatMap((s) => [
    `${s.capability}: score ${num(s.score)} · full ${s.fullTasks}/${s.tasks.length} · judge ${s.judge ? `yes ${s.judge.yes}/${s.judge.judged}` : '—'}${s.lowest ? ` · lowest ${s.lowest.id}` : ''}`,
    ...(s.notApplicable ?? []).map((n) => `${s.capability}: ${n.id} not applicable — ${n.why}`),
  ]);
}
