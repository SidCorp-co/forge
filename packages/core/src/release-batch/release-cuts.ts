// A release's attempts as its page shows them (ADR 0011), projected from the runs the version rule
// chains (`version-rule.ts:lineageOf`). Pure but for `fillCuts`, which reads the people named. A RELEASE is named by the version its last
// attempt wears, so attempts cut before a version was kept across them — HOP's 0.3.0 and 0.4.0,
// both re-cut as 0.5.0 — count once, under the release that carried their roster on.

import type {
  ReleaseContinuation,
  ReleaseCutView,
  ReleasePerson,
  ReleaseState,
  ReleaseVersionRule,
} from '@forge/contracts/releases';
import { RELEASE_VERSION_DECISIONS } from '@forge/contracts/releases';
import { peopleOf } from '../lib/people.js';
import { readFinishRecord } from './finish-record.js';
import type { Part } from './release-read-views.js';
import { carriersIn, carriersOf, type Lineage, type LineageRun } from './version-rule.js';
import { versionStatus } from './versions.js';

/** Every release, by the version its last attempt wears, with each of its attempts first first. */
export interface ReleaseLines {
  /** Each attempted run's release key. */
  keyOf: Map<string, string>;
  /** Each release key's attempts, in the order they were cut. */
  groups: Map<string, LineageRun[]>;
}

export function releaseLinesOf(lineage: Lineage): ReleaseLines {
  const keyOf = new Map<string, string>();
  const groups = new Map<string, LineageRun[]>();
  for (const [id, head] of lineage.headOf) keyOf.set(id, head.version);
  for (const [, chain] of lineage.attemptsOf) {
    const key = (chain[chain.length - 1] as LineageRun).version;
    groups.set(key, [...(groups.get(key) ?? []), ...chain]);
  }
  for (const [key, runs] of groups) {
    groups.set(
      key,
      [...runs].sort(
        (a, b) => a.startedAt.getTime() - b.startedAt.getTime() || (a.id < b.id ? -1 : 1),
      ),
    );
  }
  return { keyOf, groups };
}

/** Where a version that is not its release's own went: the release key and whether it shipped. */
export function continuationOf(
  lines: ReleaseLines,
  version: string,
  wearingRunId: string | null,
): ReleaseContinuation | null {
  const key = wearingRunId ? lines.keyOf.get(wearingRunId) : undefined;
  if (!key || key === version) return null;
  const runs = lines.groups.get(key) ?? [];
  return { version: key, shipped: runs.some((r) => r.releasedAt !== null) };
}

const obj = (v: unknown): Record<string, unknown> | null =>
  typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null;
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

/** The person who ended an attempt: its abort's actor, else its finish's; null where Forge did. */
function deciderIdOf(run: LineageRun): string | null {
  const abort = obj(run.metadata.abort);
  if (abort) return str(abort.by);
  const finish = readFinishRecord(run.metadata);
  if (!finish || (finish.state !== 'finished' && finish.state !== 'failed')) return null;
  const by = finish.requestedBy;
  return by.type === 'user' ? by.id : by.ownerId;
}

/** Every user an attempt list names, so the reader resolves them in one read. */
export function peopleNamedBy(runs: readonly LineageRun[]): string[] {
  return runs.flatMap((r) => {
    const id = deciderIdOf(r);
    return id ? [id] : [];
  });
}

function ruleOf(metadata: Record<string, unknown>): ReleaseVersionRule {
  const cut = obj(metadata.versionCut);
  const decided = cut?.decided;
  if (!cut || !(RELEASE_VERSION_DECISIONS as readonly unknown[]).includes(decided)) {
    return { decided: 'unrecorded', from: null, carriers: [], line: null, taken: false };
  }
  return {
    decided: decided as ReleaseVersionRule['decided'],
    from: str(cut.from),
    carriers: carriersIn(cut.carriers),
    line: str(cut.line),
    taken: str(cut.takenBy) !== null,
  };
}

function refusalOf(run: LineageRun): ReleaseCutView['refusal'] {
  const finish = readFinishRecord(run.metadata);
  if (finish?.state !== 'failed' || !finish.refusal) return null;
  return { code: finish.refusal.code || null, text: finish.refusal.reason };
}

function endedAtOf(run: LineageRun): Date | null {
  const abortAt = str(obj(run.metadata.abort)?.at);
  return run.releasedAt ?? run.endedAt ?? (abortAt ? new Date(abortAt) : null);
}

/**
 * One release's attempts, first first. `own` is the run the page is about and the state the read
 * model gave it, so the open attempt reads the same state the header does.
 */
export function cutViewsOf(
  runs: readonly LineageRun[],
  own: { runId: string | null; state: ReleaseState },
  cutters: ReadonlyMap<string, ReleasePerson>,
  people: ReadonlyMap<string, ReleasePerson>,
): ReleaseCutView[] {
  return runs.map((run, i) => {
    const decider = deciderIdOf(run);
    const reading = carriersOf(run);
    const outcome =
      run.id === own.runId && own.state !== 'draft'
        ? own.state
        : versionStatus(
            { status: run.status, releasedAt: run.releasedAt, metadata: run.metadata },
            null,
          );
    const ended = endedAtOf(run);
    return {
      n: i + 1,
      runId: run.id,
      version: run.version,
      cutAt: run.startedAt.toISOString(),
      cutBy: cutters.get(run.id) ?? null,
      outcome,
      endedAt: ended ? ended.toISOString() : null,
      refusal: refusalOf(run),
      abortReason: str(obj(run.metadata.abort)?.reason),
      decidedBy: decider ? (people.get(decider) ?? null) : null,
      rule: ruleOf(run.metadata),
      carried: reading.kind === 'carried' ? reading.carriers : reading.kind === 'none' ? [] : null,
    };
  });
}

/** Fills each part's attempts, with every person they name read once. */
export async function fillCuts(
  parts: readonly Part[],
  groupOf: (p: Part) => LineageRun[],
  cutters: ReadonlyMap<string, ReleasePerson>,
): Promise<void> {
  const groups = parts.map((p) => [p, groupOf(p)] as const);
  const named = await peopleOf(groups.flatMap(([, runs]) => peopleNamedBy(runs)));
  const people = new Map<string, ReleasePerson>(
    [...named].map(([id, person]) => [id, { id, ...person }]),
  );
  for (const [p, runs] of groups) {
    p.cuts = cutViewsOf(runs, { runId: p.runId, state: p.state }, cutters, people);
  }
}
