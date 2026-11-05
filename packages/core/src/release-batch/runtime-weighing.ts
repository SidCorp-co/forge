/**
 * ISS-1368 — the weighing (`issues/weighing.ts`), read by the caller before any enumerator runs,
 * since `collectReleaseBlockers` reaches no network: the release runtimes the project document
 * declares under `release.runtimes` and what each serves now, which paths each waiting issue's
 * landing changed, and what every served commit holds of every commit a verdict was judged at.
 *
 * Every read that fails is kept as the reason it failed, never as an answer: a pair whose carriage
 * was not read is weighed by equality alone, and an issue whose paths were not read owes every
 * runtime. Nothing here can make a criterion earned that equality would not have.
 */

import { type ServingReading, servedCommits } from '@forge/contracts/releases';
import { projectRunnerBuilds } from '../devices/index.js';
import {
  resolveSourceHost,
  type SourceHost,
  SourceHostUnavailable,
} from '../integrations/source-host/index.js';
import {
  type Carriage,
  type ChangedPaths,
  carriageKey,
  type LandingHeld,
  type RuntimeReading,
  rotated,
  verdictWeighingInputs,
  type Weighing,
} from '../issues/index.js';
import { recognisableIdentity, sameIdentity } from '../messaging/verdict-identity.js';
import { readProjectDocument } from '../project-config/index.js';
import { type AncestryPair, pairKey } from '../runners/index.js';
import { type AncestrySource, ancestrySourceFor } from './ancestry-source.js';
import { carriageOf, changedPathsOf } from './carriage.js';
import { recordedCarriage } from './recorded-carriage.js';
import { recordedHolding } from './recorded-holding.js';
import { persistedCarriage } from './served-ancestry.js';
import { readJudgedOnNow } from './serving-reading.js';

/** Uncached reads (one or two compares each) one weighing may make of each kind — landings and
 *  carriages, so neither can starve the other; a cached answer costs none. */
const WEIGHING_READ_LIMIT = 60;

/** Why a read path's weighing left a pair unread: no release Forge recorded places it
 *  (`recorded-carriage.ts`), the host has not answered it to the pass that asks once per pair
 *  (`served-ancestry.ts`), and a read asks the source host nothing (ISS-774). */
export const READ_PATH_HELD_ONLY =
  'no release Forge recorded shipping places it, and the source host has not answered it yet: the pipeline sweep asks once per pair, and a read asks nothing';

interface WeighingDeps {
  host?: (projectId: string) => Promise<SourceHost>;
  /** Who answers whether a served commit holds a landing; the project's own source where absent. */
  ancestry?: (projectId: string) => Promise<AncestrySource>;
  now?: () => Date;
  /** Why this weighing asks the host nothing — a read path's, which weighs only the answers this
   *  process already holds (ISS-774) — every other pair answering it; absent, it asks within budget. */
  heldOnly?: string;
}

/** The build each online, enabled runner device of this project reports. */
async function readProjectRunners(projectId: string, now: () => Date): Promise<ServingReading> {
  const rows = await projectRunnerBuilds(projectId);
  const readAt = now().toISOString();
  if (rows.length === 0) {
    return {
      kind: 'undeclared',
      missing: 'no runner device of this project is online to report the build it runs',
      route: 'bring one of this project’s runners online',
    };
  }
  const served = rows.flatMap((r) =>
    r.commit && recognisableIdentity(r.commit)
      ? [{ commit: r.commit.trim(), where: `runner device ${r.name}` }]
      : [],
  );
  const silent = rows.filter((r) => !r.commit || !recognisableIdentity(r.commit));
  const unread = silent.map((r) => `runner device ${r.name} reports no build commit`);
  if (served.length === 0) {
    return { kind: 'unreadable', why: unread.join('; '), hosts: rows.map((r) => r.name), readAt };
  }
  return { kind: 'serving', served, unread, readAt };
}

type Reader = { host: SourceHost } | { why: string };

async function readerFor(projectId: string, deps: WeighingDeps): Promise<Reader> {
  try {
    return { host: await (deps.host ?? ((id) => resolveSourceHost(id, 'kernel')))(projectId) };
  } catch (err) {
    if (err instanceof SourceHostUnavailable) return { why: err.message };
    throw err;
  }
}

const OVER_BUDGET = `it was not read this pass: one weighing makes at most ${WEIGHING_READ_LIMIT} uncached repository reads of a kind, and each pass starts its reads one place further along`;

/** Charged only where the cache misses; a reason once it is spent. */
function budget(): () => string | null {
  let spent = 0;
  return () => {
    spent += 1;
    return spent <= WEIGHING_READ_LIMIT ? null : OVER_BUDGET;
  };
}

// Each pass starts one place further along, so reads a full budget cut short are first in a later pass.
let passes = 0;

async function readChanged(
  rows: ReadonlyArray<{ id: string; landing: string | null }>,
  reader: Reader,
  spend: () => string | null,
): Promise<Map<string, ChangedPaths>> {
  const out = new Map<string, ChangedPaths>();
  for (const row of rotated(rows, passes)) {
    if (!row.landing) {
      out.set(row.id, { kind: 'unread', why: 'this issue records no landing commit' });
    } else if ('why' in reader) {
      out.set(row.id, { kind: 'unread', why: reader.why });
    } else {
      out.set(row.id, await changedPathsOf(reader.host, row.landing, spend));
    }
  }
  return out;
}

async function readCarriage(
  judged: readonly string[],
  served: readonly string[],
  reader: Reader,
  spend: () => string | null,
  recorded: ReadonlyMap<string, Carriage>,
): Promise<Map<string, Carriage>> {
  // what a release Forge recorded answers is never asked again, of the host or the process
  const out = new Map<string, Carriage>(recorded);
  const pairs = judged.flatMap((j) => served.filter((s) => !sameIdentity(j, s)).map((s) => [j, s]));
  for (const [j, s] of rotated(pairs, passes) as Array<[string, string]>) {
    const key = carriageKey(j, s);
    if (out.has(key)) continue;
    if ('why' in reader) out.set(key, { kind: 'unread', why: reader.why });
    else out.set(key, await carriageOf(reader.host, j, s, spend));
  }
  return out;
}

/** One pair's answer: whether the served commit holds the landing, and who said so; or why not read. */
type Held = { held: boolean; by: string } | { unread: string };

// Whether one commit holds another never changes once answered, so each answer read is kept, bounded.
const heldAnswers = new Map<string, { held: boolean; by: string }>();

function keepHeld(key: string, answer: { held: boolean; by: string }): void {
  heldAnswers.set(key, answer);
  if (heldAnswers.size <= 2000) return;
  const oldest = heldAnswers.keys().next().value;
  if (oldest !== undefined) heldAnswers.delete(oldest);
}

/** What Forge's own records say of each pair: equality, the releases it recorded, the host's kept
 *  answers, and the merge marks agents recorded (`recorded-holding.ts`); never the host itself. */
async function recordedHeld(
  projectId: string,
  pairs: readonly AncestryPair[],
): Promise<Map<string, Held>> {
  const landings = [...new Set(pairs.map((p) => p.commit))];
  const served = [...new Set(pairs.map((p) => p.release))];
  const [released, kept, marked] = await Promise.all([
    recordedCarriage(projectId, landings, served),
    persistedCarriage(projectId, landings, served),
    recordedHolding(projectId, pairs),
  ]);
  const out = new Map<string, Held>();
  for (const p of pairs) {
    if (sameIdentity(p.commit, p.release, { abbreviating: true })) {
      out.set(pairKey(p), { held: true, by: 'equality' });
      continue;
    }
    const key = carriageKey(p.commit, p.release);
    const record = released.get(key) ?? kept.get(key);
    if (record && record.kind !== 'unread') {
      const by = released.has(key) ? "Forge's release records" : 'the source host, as kept';
      out.set(pairKey(p), { held: record.kind === 'descends', by });
      continue;
    }
    const mark = marked.get(pairKey(p));
    if (mark === true) out.set(pairKey(p), { held: true, by: 'the merge marks recorded here' });
    else
      out.set(pairKey(p), { unread: typeof mark === 'object' ? mark.unread : 'nothing answered' });
  }
  return out;
}

/** Who an ancestry source is, in the words a hold names it by. */
function sourceName(source: Exclude<AncestrySource, { kind: 'none' }>): string {
  return source.kind === 'host' ? 'the source host' : "the box holding this project's checkout";
}

/** Asks the project's ancestry source each pair no record answered, within `limit`. */
async function askedHeld(
  projectId: string,
  pairs: readonly AncestryPair[],
  ancestry: (projectId: string) => Promise<AncestrySource>,
): Promise<Map<string, Held>> {
  const out = new Map<string, Held>();
  if (pairs.length === 0) return out;
  const source = await ancestry(projectId);
  if (source.kind === 'none') {
    for (const p of pairs) out.set(pairKey(p), { unread: source.why });
    return out;
  }
  const asked = pairs.slice(0, WEIGHING_READ_LIMIT);
  for (const p of pairs.slice(WEIGHING_READ_LIMIT)) out.set(pairKey(p), { unread: OVER_BUDGET });
  const answers = await source.reader.ask(asked);
  if ('silent' in answers) {
    // no source host is bound, and no box holding the checkout answered either
    const why = `${source.kind === 'box' ? `${source.why}; ` : ''}${answers.silent}`;
    for (const p of asked) out.set(pairKey(p), { unread: why });
    return out;
  }
  const by = sourceName(source);
  for (const p of asked) {
    const answer = answers.get(pairKey(p));
    if (typeof answer === 'boolean') {
      out.set(pairKey(p), { held: answer, by });
      keepHeld(`${projectId}\u0000${pairKey(p)}`, { held: answer, by });
    } else {
      out.set(pairKey(p), { unread: answer?.unread ?? `${by} gave no answer` });
    }
  }
  return out;
}

/** One issue's answers across every served commit: held where any holds it, unread where any was not
 *  read, else held by none. */
function landingHeldOf(
  landing: string,
  served: readonly string[],
  answers: ReadonlyMap<string, Held>,
): LandingHeld {
  const each = served.map((s) => ({
    at: s,
    answer: answers.get(pairKey({ commit: landing, release: s })) ?? {
      unread: 'it was not asked',
    },
  }));
  const at = each.flatMap((e) => ('held' in e.answer && e.answer.held ? [e.at] : []));
  if (at.length > 0) return { kind: 'holds', landing, at };
  const unread = each.find((e) => 'unread' in e.answer)?.answer;
  if (unread && 'unread' in unread) return { kind: 'unread', landing, why: unread.unread };
  const first = each[0]?.answer;
  return { kind: 'lacks', landing, by: first && 'by' in first ? first.by : 'nothing' };
}

/**
 * Whether what an unreleased issue is weighed on (`served`) holds each issue's landing commit
 * (ISS-997): agenfold's 0.140.0 hold asked for verdicts at 87a8c61, the 0.139.0 build, which does not
 * hold ISS-171's landing 7e24f05, so no verdict there could be about it. Forge's records answer first;
 * a read path (`heldOnly`) asks nothing more, and the sweep asks the project's ancestry source
 * (`ancestry-source.ts`: its source host, or the box holding its checkout), keeping each answer.
 */
async function readLandings(
  projectId: string,
  rows: ReadonlyArray<{ id: string; landing: string | null }>,
  served: readonly string[],
  heldOnly: string | undefined,
  ancestry: (projectId: string) => Promise<AncestrySource>,
): Promise<Map<string, LandingHeld>> {
  const out = new Map<string, LandingHeld>();
  if (served.length === 0) return out;
  const lower = (sha: string) => sha.trim().toLowerCase();
  const landings = [...new Set(rows.flatMap((r) => (r.landing ? [lower(r.landing)] : [])))];
  const pairs = landings.flatMap((commit) => served.map((s) => ({ commit, release: lower(s) })));
  const answers = await recordedHeld(projectId, pairs);
  const owed = pairs.filter((p) => {
    const kept = heldAnswers.get(`${projectId}\u0000${pairKey(p)}`);
    if (kept && 'unread' in (answers.get(pairKey(p)) ?? {})) answers.set(pairKey(p), kept);
    return 'unread' in (answers.get(pairKey(p)) ?? { unread: '' });
  });
  if (heldOnly !== undefined) {
    for (const p of owed) answers.set(pairKey(p), { unread: heldOnly });
  } else {
    for (const [key, answer] of await askedHeld(projectId, owed, ancestry)) {
      answers.set(key, answer);
    }
  }
  const servedLower = served.map(lower);
  for (const row of rows) {
    const held: LandingHeld = row.landing
      ? landingHeldOf(lower(row.landing), servedLower, answers)
      : { kind: 'unread', landing: null, why: 'this issue records no landing commit' };
    out.set(row.id.toLowerCase(), held);
  }
  return out;
}

/**
 * The weighing for these waiting issues — the project's unclaimed `awaiting_release` rows where
 * none are named — beside `serving`, the deployment's reading the caller already took, and the
 * reading of the environment the project's changes are judged on, which an unreleased issue's
 * runtime verdicts are weighed against (`issues/runtime-standing.ts:weighedOn`). A project
 * declaring no runtime, whose verdicts name what it serves, makes no repository read at all.
 */
export async function readWeighingNow(
  projectId: string,
  serving: ServingReading,
  issueIds?: readonly string[],
  deps: WeighingDeps = {},
): Promise<Weighing> {
  const now = deps.now ?? (() => new Date());
  const declared = (await readProjectDocument(projectId))?.document.release?.runtimes ?? [];
  const runtimes: RuntimeReading[] = [];
  let runnersRead: ServingReading | null = null;
  for (const runtime of declared) {
    runnersRead ??= await readProjectRunners(projectId, now);
    runtimes.push({ name: runtime.name, paths: runtime.paths, serving: runnersRead });
  }
  const judgedOn = await readJudgedOnNow(projectId, now);
  const { rows, judged } = await verdictWeighingInputs(projectId, issueIds);
  const served = [
    ...new Set([
      ...servedCommits(serving),
      ...(judgedOn.kind === 'read' ? servedCommits(judgedOn.serving) : []),
      ...runtimes.flatMap((r) => servedCommits(r.serving)),
    ]),
  ];
  const { heldOnly } = deps;
  // an unreleased issue is weighed on the judged-on environment where one is read, else production
  const on = judgedOn.kind === 'read' ? judgedOn.serving : serving;
  const landings = await readLandings(
    projectId,
    rows,
    servedCommits(on),
    heldOnly,
    deps.ancestry ?? ((id) => ancestrySourceFor(id)),
  );
  const unequal = judged.some((j) => served.some((s) => !sameIdentity(j, s)));
  if (runtimes.length === 0 && !unequal) {
    return { read: true, runtimes, changed: new Map(), carriage: new Map(), judgedOn, landings };
  }
  const reader = await readerFor(projectId, deps);
  passes += 1;
  const spend = () => (heldOnly === undefined ? budget() : () => heldOnly);
  const changed = runtimes.length > 0 ? await readChanged(rows, reader, spend()) : new Map();
  const recorded = new Map([
    ...(await recordedCarriage(projectId, judged, served)),
    ...(await persistedCarriage(projectId, judged, served)),
  ]);
  const carriage = await readCarriage(judged, served, reader, spend(), recorded);
  return { read: true, runtimes, changed, carriage, judgedOn, landings };
}
