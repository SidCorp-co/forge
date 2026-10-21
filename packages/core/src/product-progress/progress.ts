// The progress block every requirement and feedback answer of the product layer carries, on /mcp
// and at the Forge door (owner rule 2026-10-16: a person is always told whether work is running and
// when it is forecast to be done). It reads what the screens read — the live runs (`runs`), the scope
// forecast (`forecast`) and its ETA sentence (`report-queries/roadmap-eta.ts:etaOf`) — and never
// computes a date of its own: where the forecast holds none, it says so and why (VISION:
// state-never-lies).

import {
  type DeliveryForecast,
  deliveryDatesOf,
  FORECAST_LABEL,
  type ForecastPaused,
  type IssueProgress,
} from '@forge/contracts/forecast';
import type {
  ProductProgress as Progress,
  ProgressEta,
  ProgressRun,
  ProgressWait,
} from '@forge/contracts/product-progress';
import {
  RUN_STANDING_LIST_MAX,
  type RunStanding,
  type RunState,
} from '@forge/contracts/run-standing';
import { issueRowsOfRequirements, requirementBySeq } from '../forecast/index.js';
import { issueDisplayIds } from '../issues/index.js';
import { etaOf } from '../report-queries/index.js';
import { listRunStanding } from '../runs/index.js';

export type { Progress, ProgressEta, ProgressRun, ProgressWait };

const WORKING: readonly RunState[] = ['claimed', 'running'];
const RUN_STATE_WORDS: Record<RunState, string> = {
  queued: 'queued',
  claimed: 'starting',
  running: 'running',
  waiting_person: 'waiting on a person',
  waiting_gate: 'waiting on a gate',
  stuck: 'stuck',
  done: 'done',
  failed: 'failed',
  cancelled: 'cancelled',
  handed_back: 'handed back',
};

const NO_FORECAST = /^no forecast: /;
const day = (iso: string) => iso.slice(0, 10);

/** The project's unfinished runs by each issue key they work, read once per answer. */
export async function liveRunsByIssue(
  projectId: string,
  userId: string,
): Promise<Map<string, RunStanding[]>> {
  const listed = await listRunStanding(
    projectId,
    { scope: 'live', limit: RUN_STANDING_LIST_MAX, offset: 0 },
    { userId },
  );
  const byKey = new Map<string, RunStanding[]>();
  for (const run of listed.items) {
    const keys = new Set([...run.issues, ...(run.issue ? [run.issue.key] : [])]);
    for (const key of keys) byKey.set(key, [...(byKey.get(key) ?? []), run]);
  }
  return byKey;
}

/** One issue of a requirement as progress reads it: its key and status. */
export interface WorkIssue {
  key: string;
  status: string;
}

/** Each requirement's issues by key and status, keyed by requirement id. */
export async function issuesOfRequirements(
  projectId: string,
  requirementIds: readonly string[],
): Promise<Map<string, WorkIssue[]>> {
  const rows = await issueRowsOfRequirements(projectId, requirementIds);
  const keys = await issueDisplayIds([...rows.values()].flat().map((r) => r.id));
  return new Map(
    [...rows].map(([reqId, issues]) => [
      reqId,
      issues.flatMap((i) => {
        const key = keys.get(i.id);
        return key ? [{ key, status: i.status }] : [];
      }),
    ]),
  );
}

/** The ids of the requirements `keys` (REQ-n) name in the project; a key naming none is left out. */
export async function requirementIdsOf(
  projectId: string,
  keys: readonly string[],
): Promise<Map<string, string>> {
  const found = await Promise.all(
    [...new Set(keys)].map(async (key) => {
      const seq = /^REQ-(\d+)$/.exec(key)?.[1];
      const row = seq ? await requirementBySeq(projectId, Number(seq)) : null;
      return row ? ([key, row.id] as const) : null;
    }),
  );
  return new Map(found.filter((f): f is readonly [string, string] => f !== null));
}

/** The unfinished runs on any of `keys`, each once. */
export function runsOn(byKey: Map<string, RunStanding[]>, keys: readonly string[]): RunStanding[] {
  const seen = new Map<string, RunStanding>();
  for (const key of keys) for (const run of byKey.get(key) ?? []) seen.set(run.id, run);
  return [...seen.values()];
}

function runOf(run: RunStanding): ProgressRun {
  return {
    issue: run.issue?.key ?? run.issues[0] ?? null,
    title: run.title,
    issueStatus: run.issue?.status ?? null,
    state: run.state,
    step: run.step.step,
    since: run.since,
  };
}

/** What a run waiting on a person or a gate, or stuck, waits on. */
function runWaits(runs: readonly RunStanding[]): ProgressWait[] {
  return runs
    .filter(
      (r) => r.state === 'waiting_person' || r.state === 'waiting_gate' || r.state === 'stuck',
    )
    .map((r) => {
      const w = r.waitingOn;
      const ref = r.issue?.key ?? null;
      if (w.kind === 'gate') {
        return { who: 'A gate', act: w.gate, why: w.rule, ref, at: w.resumesAt, late: false };
      }
      return { who: w.who, act: w.act, why: w.rule, ref, at: w.dueAt, late: false };
    });
}

export function pausedWait(p: ForecastPaused): ProgressWait {
  return {
    who: p.who,
    act: p.act,
    why: p.reason,
    ref: p.ref,
    at: p.since,
    late: p.late !== null,
  };
}

/** What a delivery forecast says is owed before it can go on: a paused landing, or a person's release act. */
function deliveryWaits(d: DeliveryForecast | null): ProgressWait[] {
  if (!d || d.shipped) return [];
  const out: ProgressWait[] = [];
  if (d.landing.kind === 'paused') out.push(pausedWait(d.landing));
  if (d.release?.kind === 'person') {
    out.push({
      who: d.release.who,
      act: d.release.act,
      why: d.release.reason,
      ref: d.release.version,
      at: null,
      late: false,
    });
  }
  return out;
}

export function etaFrom(delivery: DeliveryForecast | null, noDelivery: string): ProgressEta {
  if (!delivery) return { estimate: false, done: false, why: noDelivery };
  const read = etaOf(delivery);
  if (delivery.shipped) return { estimate: false, done: true, why: read.basis };
  const dates = deliveryDatesOf(delivery);
  if (!dates) return { estimate: false, done: false, why: read.basis.replace(NO_FORECAST, '') };
  const range = delivery.landing.kind === 'forecast' ? delivery.landing : null;
  return {
    estimate: true,
    likelyBy: dates.p50At,
    almostSurelyBy: dates.p85At,
    of: dates.of,
    basis: read.basis,
    confidence: range?.confidence.level ?? null,
    late: range?.late ?? null,
  };
}

function waitKey(w: ProgressWait) {
  return `${w.who}\u0000${w.act}`;
}

function runSentence(runs: readonly ProgressRun[]): string {
  const working = runs.filter((r) => WORKING.includes(r.state));
  const named = (rs: readonly ProgressRun[]) =>
    rs.map((r) => `${r.issue ?? r.title} (${r.step ?? RUN_STATE_WORDS[r.state]})`).join(', ');
  if (working.length > 0) return `Running now: ${named(working)}.`;
  if (runs.length === 0) return 'Nothing is running right now.';
  return `Nothing is running right now; ${runs
    .map((r) => `${r.issue ?? r.title} is ${RUN_STATE_WORDS[r.state]}`)
    .join(', ')}.`;
}

function etaSentence(eta: ProgressEta): string {
  if (!eta.estimate) return eta.done ? `Done: ${eta.why}.` : `No estimate: ${eta.why}.`;
  const of = eta.of === 'hands' ? "in people's hands" : 'merged; its release has no date';
  const late = eta.late ? ' It is running late.' : '';
  return `Likely done by ${day(eta.likelyBy)}, almost surely by ${day(eta.almostSurelyBy)} (${of}).${late}`;
}

/**
 * The block, composed from what was read. `noDelivery` says why there is no estimate where the
 * forecast holds no delivery for it at all (no issue carries it, it is not agreed, it is declined):
 * the caller knows why, and the block refuses to go without it.
 */
export function progressOf(input: {
  asOf: string;
  work: IssueProgress | null;
  runs: readonly RunStanding[];
  waits: readonly ProgressWait[];
  delivery: DeliveryForecast | null;
  noDelivery: string;
}): Progress {
  if (!input.delivery && input.noDelivery.trim() === '') {
    throw new Error('progress: no delivery forecast and no reason why, so the ETA would be silent');
  }
  const runs = input.runs.map(runOf);
  const unique = new Map<string, ProgressWait>();
  for (const w of [...input.waits, ...runWaits(input.runs), ...deliveryWaits(input.delivery)]) {
    if (!unique.has(waitKey(w))) unique.set(waitKey(w), w);
  }
  const waitingOn = [...unique.values()];
  const eta = etaFrom(input.delivery, input.noDelivery);
  const waits = waitingOn
    .slice(0, 2)
    .map((w) => `Waiting on ${w.who}${w.act ? ` to ${w.act}` : ''}.`);
  return {
    label: FORECAST_LABEL,
    asOf: input.asOf,
    running: runs.some((r) => WORKING.includes(r.state)),
    says: [runSentence(runs), ...waits, etaSentence(eta)].join(' '),
    work: input.work,
    runs,
    waitingOn,
    eta,
  };
}
