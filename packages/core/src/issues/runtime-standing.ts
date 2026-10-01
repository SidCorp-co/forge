/**
 * ISS-1368 — a verdict weighed against each runtime its issue's change runs in, rather than against
 * one serving commit per project. Equality (`verdict-standing.ts`) decides first; where it says
 * superseded, a served commit that descends from the judged one, or differs from it only in files
 * this runtime does not run, carries it. Every carriage answer is the weighing's, read before this
 * runs; an answer the weighing does not hold earns nothing.
 */

import { type ServingReading, servedCommits } from '../release-batch/serving-reading.js';
import {
  carriageKey,
  claimedBy,
  claimedByAny,
  type RuntimeReading,
  type Weighing,
} from '../release-batch/weighing.js';
import {
  EARNED_STANDINGS,
  type IssueIdentities,
  type VerdictIdentity,
  type VerdictStanding,
  verdictStanding,
} from './verdict-standing.js';

/** The runtimes one issue's verdicts are weighed against. */
export interface OwedRuntimes {
  readonly deployment: boolean;
  readonly declared: readonly RuntimeReading[];
  /** Why the landing's paths were not read, which is why every runtime is owed; null where read. */
  readonly unread: string | null;
}

export function owedRuntimes(issueId: string, weighing: Weighing): OwedRuntimes {
  if (weighing.runtimes.length === 0) return { deployment: true, declared: [], unread: null };
  const changed = weighing.changed.get(issueId);
  if (!changed || changed.kind === 'unread') {
    const unread = changed?.why ?? 'they were not read';
    return { deployment: true, declared: weighing.runtimes, unread };
  }
  const declared = weighing.runtimes.filter((r) =>
    changed.paths.some((p) => claimedBy(r.paths, p)),
  );
  const deployment =
    changed.paths.length === 0 || changed.paths.some((p) => !claimedByAny(weighing.runtimes, p));
  return { deployment, declared, unread: null };
}

/** How a verdict stood, and against which runtime's reading that was decided. */
export interface WeighedVerdict {
  readonly standing: VerdictStanding;
  /** The declared runtime that decided, or null for the deployment. */
  readonly runtime: string | null;
  readonly serving: ServingReading;
  /** What the weighing read about the served commits, said after the standing where it holds. */
  readonly beside: readonly string[];
}

const SHOWN_FILES = 3;

function filesClause(files: readonly string[]): string {
  const shown = files.slice(0, SHOWN_FILES).map((f) => `\`${f}\``);
  const more = files.length > SHOWN_FILES ? ` and ${files.length - SHOWN_FILES} more` : '';
  const n = `${files.length} file${files.length === 1 ? '' : 's'}`;
  return `${n} it runs: ${shown.join(', ')}${more}`;
}

function weighIn(
  at: VerdictIdentity | null,
  serving: ServingReading,
  identities: IssueIdentities,
  runs: (file: string) => boolean,
  weighing: Weighing,
  declared: boolean,
): { standing: VerdictStanding; beside: string[] } {
  // A declared runtime's reading is missing NOW, which is not ISS-1286's project with no route.
  if (declared && serving.kind !== 'serving') return { standing: 'superseded', beside: [] };
  const standing = verdictStanding(at, serving, identities);
  if (standing !== 'superseded' || !at || serving.kind !== 'serving')
    return { standing, beside: [] };
  const beside: string[] = [];
  const commits = servedCommits(serving);
  for (const served of commits) {
    // The judge clause names what is served, once (ISS-1346); a commit is named here only where
    // the reading holds several and the sentence would not say which.
    const what = commits.length > 1 ? `\`${served}\`` : 'what it serves';
    const carriage = weighing.carriage.get(carriageKey(at.value, served));
    if (!carriage) {
      if (weighing.read) beside.push(`whether ${what} carries it was not read`);
      continue;
    }
    if (carriage.kind === 'descends') return { standing: 'stands', beside: [] };
    if (carriage.kind === 'unread') {
      beside.push(`whether ${what} carries it could not be read: ${carriage.why}`);
      continue;
    }
    const differing = carriage.paths.filter(runs);
    if (differing.length === 0) return { standing: 'stands', beside: [] };
    beside.push(
      `${what} does not descend from it and differs from it in ${filesClause(differing)}`,
    );
  }
  return { standing, beside };
}

/**
 * The standing a verdict earns across every runtime its issue owes: the first runtime that does not
 * earn it decides, then the first that earns it only uncorroborated, else the first.
 */
export function weighVerdict(
  at: VerdictIdentity | null,
  serving: ServingReading,
  identities: IssueIdentities,
  owed: OwedRuntimes,
  weighing: Weighing,
): WeighedVerdict {
  const results: WeighedVerdict[] = [];
  if (owed.deployment) {
    const runs = (file: string) => !claimedByAny(weighing.runtimes, file);
    const weighed = weighIn(at, serving, identities, runs, weighing, false);
    results.push({ runtime: null, serving, ...weighed });
  }
  for (const r of owed.declared) {
    const runs = (file: string) => claimedBy(r.paths, file);
    const weighed = weighIn(at, r.serving, identities, runs, weighing, true);
    results.push({ runtime: r.name, serving: r.serving, ...weighed });
  }
  const failing = results.find((r) => !EARNED_STANDINGS.has(r.standing));
  if (failing) {
    const unread = owed.unread
      ? [
          `what this issue's landing changed could not be read (${owed.unread}), so it is weighed against every runtime`,
        ]
      : [];
    return { ...failing, beside: [...failing.beside, ...unread] };
  }
  return results.find((r) => r.standing === 'uncorroborated') ?? (results[0] as WeighedVerdict);
}
