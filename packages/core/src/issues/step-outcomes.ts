// What each step of an issue's run came to: its handoff line, its time and its cost.

import type { IssueStepHandoff, IssueStepOutcome } from '@forge/contracts/issue-standing';

export interface StepDurationFact {
  runId: string;
  step: string;
  durationSeconds: number;
  costUsd: number;
  at: string;
}

const truncate = (s: string, max: number) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

const OUTCOME_KEYS = [
  'outcome',
  'summary',
  'verdict',
  'result',
  'planSummary',
  'rootCauseHypothesis',
];

/** A short line from a free-form handoff payload: the stable fields first, then any string. */
function outcomeLabelOf(payload: Record<string, unknown> | null): string | null {
  if (!payload) return null;
  for (const k of OUTCOME_KEYS) {
    const v = payload[k];
    if (typeof v === 'string' && v.trim()) return truncate(v, 90);
  }
  for (const v of Object.values(payload)) {
    if (typeof v === 'string' && v.trim()) return truncate(v, 90);
  }
  return null;
}

// one entry per job type a handoff or a step duration records, ordered by when it last ran; the
// latest run's attempts are summed and the latest attempt's handoff attached
export function stepOutcomesOf(input: {
  handoffs: readonly IssueStepHandoff[];
  durations: readonly StepDurationFact[];
  activeStep: string | null;
  failedStep: string | null;
}): IssueStepOutcome[] {
  const handoffByStep = new Map<string, IssueStepHandoff>();
  for (const h of input.handoffs) {
    const prev = handoffByStep.get(h.step);
    if (
      !prev ||
      h.updatedAt > prev.updatedAt ||
      (h.updatedAt === prev.updatedAt && h.attempt > prev.attempt)
    )
      handoffByStep.set(h.step, h);
  }
  const runsByStep = new Map<string, Map<string, { seconds: number; cost: number; at: string }>>();
  for (const d of input.durations) {
    const runs = runsByStep.get(d.step) ?? new Map();
    const acc = runs.get(d.runId) ?? { seconds: 0, cost: 0, at: '' };
    acc.seconds += d.durationSeconds;
    acc.cost += d.costUsd;
    if (d.at > acc.at) acc.at = d.at;
    runs.set(d.runId, acc);
    runsByStep.set(d.step, runs);
  }
  const out: IssueStepOutcome[] = [];
  for (const step of new Set([...handoffByStep.keys(), ...runsByStep.keys()])) {
    const handoff = handoffByStep.get(step) ?? null;
    let pick: { seconds: number; cost: number; at: string } | undefined;
    for (const acc of runsByStep.get(step)?.values() ?? [])
      if (!pick || acc.at > pick.at) pick = acc;
    out.push({
      step,
      state: input.failedStep === step ? 'failed' : input.activeStep === step ? 'running' : 'done',
      outcomeLabel: outcomeLabelOf(handoff?.payload ?? null),
      durationSeconds: pick && pick.seconds > 0 ? pick.seconds : null,
      costUsd: pick && pick.cost > 0 ? pick.cost : null,
      handoff,
      ranAt: pick?.at || handoff?.updatedAt || '',
    });
  }
  return out.sort((a, b) => a.ranAt.localeCompare(b.ranAt));
}
