/**
 * Whether what a project serves carries each commit a verdict on it was judged at, asked of the source
 * host once per pair by the pipeline sweep and kept (`served_ancestry`), so a read answers from the
 * row and asks no host (ISS-774), and a deploy empties nothing. On forge-dev every push to `dev`
 * deploys and a `-dev.N` release is only a snapshot (`deploy-dev.yml`), so the commit served is
 * usually one no release recorded and the release records (`recorded-carriage.ts`) cannot place it:
 * every runtime verdict a deploy ago read unread (REQ-79, 2026-10-30).
 *
 * Each pass reads what each project serves (production, and the environment its changes are judged
 * on), and asks for every pair it holds no row and no release record for, newest verdict first. In
 * turn with those it asks whether each commit an issue's verdicts name holds that issue's landing, or
 * the landing descends from it, where no landing mark and no kept row says (`owedLandingPairs`):
 * sidcorp-mail's ISS-7 shipped in 0.9.0 and was judged at 62a4ac7, which 0.16.0 shipped (ISS-1079,
 * `shipped-holding.ts`), and adminhub-api's landings on `release/stg` were judged on production's
 * `release/production` (ISS-1169); only a kept answer lets coverage count either. A door that asks the
 * host the same question keeps a `holds` answer too
 * (`keepHolding`, from `verdict-commit-placement.ts:commitPlacedOnLanding`). A host
 * that does not answer writes nothing, so the pair stays unread with its reason and the next pass asks
 * again. The work is bounded: at most `ANCESTRY_PROJECTS_PER_PASS` projects are read a pass, and at most
 * `ANCESTRY_ASKS_PER_PASS` pairs not already held are asked of the host across all of them (each one
 * compare, or a compare and the paged file lists where it does not descend); each pass starts one
 * project further along, so a budget a pass spent is spent elsewhere first in the next.
 */

import { servedCommits } from '@forge/contracts/releases';
import { and, inArray, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { idOfParts, memoizedPerId, partsOf } from '../db/read-memo.js';
import { servedAncestry } from '../db/schema.js';
import {
  resolveSourceHost,
  type SourceHost,
  SourceHostUnavailable,
} from '../integrations/source-host/index.js';
import { type Carriage, carriageKey, rotated } from '../issues/index.js';
import { logger } from '../lib/logger.js';
import { pairKey } from '../runners/index.js';
import { carriageOf } from './carriage.js';
import { holdingPair, landedBuildsOf } from './landed-build.js';
import { recordedCarriage } from './recorded-carriage.js';
import { recordedHolding } from './recorded-holding.js';
import { bridgesOwed, heldBefore, keepDerived, keepServedBuilds } from './served-builds.js';
import { readJudgedOnNow, readServingNow } from './serving-reading.js';
import { type ShippedAsk, shippedAskKey, shippedCommitHolding } from './shipped-holding.js';

/** How many projects one pass reads what they serve of. */
export const ANCESTRY_PROJECTS_PER_PASS = 10;
/** How many pairs not already held one pass asks the source host about, across every project. */
export const ANCESTRY_ASKS_PER_PASS = 30;

const WHOLE = /^[0-9a-f]{40}$/;
const lower = (sha: string) => sha.trim().toLowerCase();

export interface ServedAncestryPassResult {
  projects: number;
  asked: number;
  written: number;
  /** Pairs the host did not answer this pass, each left unread for the next. */
  unread: number;
  /** Pairs kept as held because a build served before held them and the live one descends from it. */
  derived: number;
  /** Pairs the host left unanswered on an earlier pass, not asked this one (`UNANSWERED`). */
  deferred: number;
  /** The pairs the host did not answer this pass, `project judged>served: why`, ten at most. */
  unreadPairs: string[];
}

/**
 * Pairs the host did not answer, by project and pair: asked again after 1, 2, 4 … 64 passes (about an
 * hour at a pass a minute), so a pair it can never answer (a commit gone from it, two commits with no
 * common ancestor) stops spending every pass's budget. Before ISS-1182 round 2 nine or ten pairs were
 * asked and left unread on every pass. Kept in this process only: a restart asks each once more, and
 * the pass's log line names each one it leaves unread. A bridge after a deploy is never deferred.
 */
const UNANSWERED = new Map<string, { misses: number; next: number }>();
const UNANSWERED_LIMIT = 2_000;
const unansweredKey = (projectId: string, pair: Owed) =>
  `${projectId}\u0000${carriageKey(pair.judged, pair.served)}`;

/** The projects holding a live criterion whose newest verdict names a whole commit or runtime. */
async function judgedProjects(): Promise<string[]> {
  const rows = (await db.execute(sql`
    SELECT DISTINCT i.project_id
      FROM criterion_verdicts v
      JOIN issue_criteria c ON c.id = v.criterion_id AND c.retired_at IS NULL
      JOIN issues i ON i.id = c.issue_id AND i.status <> 'dropped'
     WHERE v.identity_kind IN ('commit', 'runtime')
     ORDER BY i.project_id
  `)) as unknown as Array<{ project_id: string }>;
  return rows.map((r) => r.project_id);
}

/** Each whole commit a live criterion's newest verdict on the project names, newest first. */
export async function judgedCommitsOf(projectId: string): Promise<string[]> {
  const rows = (await db.execute(sql`
    SELECT judged, max(at) AS at FROM (
      SELECT DISTINCT ON (c.id) lower(coalesce(v.commit_sha, v.runtime_ref)) AS judged,
             v.created_at AS at
        FROM issue_criteria c
        JOIN issues i ON i.id = c.issue_id
        JOIN criterion_verdicts v ON v.criterion_id = c.id
       WHERE i.project_id = ${projectId} AND i.status <> 'dropped' AND c.retired_at IS NULL
       ORDER BY c.id, v.created_at DESC, v.id DESC
    ) newest
     WHERE judged ~ '^[0-9a-f]{40}$'
     GROUP BY judged
     ORDER BY max(at) DESC
  `)) as unknown as Array<{ judged: string }>;
  return rows.map((r) => r.judged);
}

/** The whole commits the project's production and judged-on environments answer serving now, and
 *  production's alone. */
async function servedNow(projectId: string): Promise<{ all: string[]; production: string[] }> {
  const whole = (xs: readonly string[]) => [...new Set(xs.map(lower).filter((c) => WHOLE.test(c)))];
  const production = whole(servedCommits(await readServingNow(projectId)));
  const judgedOn = await readJudgedOnNow(projectId);
  return {
    all: whole([
      ...production,
      ...(judgedOn.kind === 'read' ? servedCommits(judgedOn.serving) : []),
    ]),
    production,
  };
}

/**
 * What the host answered about each held pair of `judged` × `served`, by `carriageKey`. A pair's
 * answer is its project's own, so every project's asks before the quiet point are one read
 * (`db/read-memo.ts:memoizedPerId`, ISS-1070 r10).
 */
export async function persistedCarriage(
  projectId: string,
  judged: readonly string[],
  served: readonly string[],
): Promise<Map<string, Carriage>> {
  const j = [...new Set(judged.map(lower).filter((c) => WHOLE.test(c)))];
  const s = [...new Set(served.map(lower).filter((c) => WHOLE.test(c)))];
  if (j.length === 0 || s.length === 0) return new Map();
  const held = await memoizedPerId(
    'persistedCarriage',
    j.flatMap((judgedCommit) =>
      s.map((servedCommit) => idOfParts(projectId, judgedCommit, servedCommit)),
    ),
    carriagesOf,
  );
  return new Map(
    [...held].map(([key, carriage]) => {
      const [, judgedCommit = '', servedCommit = ''] = partsOf(key);
      return [carriageKey(judgedCommit, servedCommit), carriage];
    }),
  );
}

/** Each asked project, judged and served commit's (`idOfParts`) kept answer, where one is kept. */
async function carriagesOf(keys: readonly string[]): Promise<Map<string, Carriage>> {
  const parts = keys.map((k) => partsOf(k));
  const rows = await db
    .select()
    .from(servedAncestry)
    .where(
      and(
        inArray(servedAncestry.projectId, [...new Set(parts.map((p) => p[0] as string))]),
        inArray(servedAncestry.servedCommit, [...new Set(parts.map((p) => p[2] as string))]),
        inArray(servedAncestry.judgedCommit, [...new Set(parts.map((p) => p[1] as string))]),
      ),
    );
  const asked = new Set(keys);
  const out = new Map<string, Carriage>();
  for (const r of rows) {
    const key = idOfParts(r.projectId, r.judgedCommit, r.servedCommit);
    if (!asked.has(key)) continue;
    out.set(
      key,
      r.carried
        ? { kind: 'descends', by: `the source host answered so at ${r.readAt.toISOString()}` }
        : { kind: 'differs', paths: r.differsIn ?? [] },
    );
  }
  return out;
}

async function hostOf(projectId: string): Promise<SourceHost | { why: string }> {
  try {
    return await resolveSourceHost(projectId, 'kernel');
  } catch (err) {
    if (err instanceof SourceHostUnavailable) return { why: err.message };
    throw err;
  }
}

function uniquePairs<P extends { judged: string; served: string }>(pairs: readonly P[]): P[] {
  const seen = new Set<string>();
  return pairs.filter((p) => {
    const key = carriageKey(p.judged, p.served);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * The pairs of one project no row and no release record answers, newest verdict first. A pair at a
 * `production` commit is not owed where a build served before it held the judged commit and the host
 * answered the live build descends from that one (`served-builds.ts:heldBefore`, ISS-1182); such a
 * pair is `derived`, for the pass to keep, so the next deploy reads it from its row.
 */
async function owedPairs(
  projectId: string,
  served: readonly string[],
  production: readonly string[] = [],
): Promise<{ owed: Owed[]; derived: Owed[] }> {
  const judged = await judgedCommitsOf(projectId);
  const [held, recorded, ...derivedOf] = await Promise.all([
    persistedCarriage(projectId, judged, served),
    recordedCarriage(projectId, judged, served),
    ...production.map((live) => heldBefore(projectId, live, judged, [])),
  ]);
  const heldAt = new Map(production.map((live, i) => [live, derivedOf[i]] as const));
  const owed: Owed[] = [];
  const derived: Owed[] = [];
  for (const j of judged) {
    for (const s of served) {
      if (s === j || held.has(carriageKey(j, s)) || recorded.has(carriageKey(j, s))) continue;
      if (heldAt.get(s)?.get(j) === true) derived.push({ judged: j, served: s });
      else owed.push({ judged: j, served: s });
    }
  }
  return { owed, derived };
}

/** A pair the pass asks; `back` asks the other way too where the first answer does not hold. */
interface Owed {
  judged: string;
  served: string;
  back?: true;
}

/**
 * Per issue whose newest live verdicts name a whole commit other than its landing, the pair (landing,
 * that commit) that no landing mark and no kept row answers: what a requirement's coverage and the
 * release hold read at the landing (`landed-build-holds.ts:laterHoldersOf`, `earlierCarriageOf`), and
 * what the pass asks of the host. The marks answer only on one branch, so a project that lands on one
 * and promotes to another needs the host for every pass judged across them (ISS-1169: adminhub-api's
 * passes at production f6ff753 and at e663b765, its landing e2c9c827's parent). At a commit a shipped
 * release recorded shipping, the release holding the issue answers first (`shipped-holding.ts`,
 * ISS-1079). Where the commit does not hold the landing, whether the landing descends from it is asked
 * too (`back`), so a pass at an earlier build is weighed as carried or as another build
 * (`landed-build-holds.ts:earlierCarriageOf`), never left unread.
 */
async function owedLandingPairs(projectId: string): Promise<Owed[]> {
  const rows = (await db.execute(sql`
    SELECT DISTINCT newest.issue_id, newest.judged FROM (
      SELECT DISTINCT ON (c.id) c.issue_id::text AS issue_id,
             lower(coalesce(v.commit_sha, v.runtime_ref)) AS judged
        FROM issue_criteria c
        JOIN issues i ON i.id = c.issue_id
        JOIN criterion_verdicts v ON v.criterion_id = c.id
       WHERE i.project_id = ${projectId} AND i.status <> 'dropped' AND c.retired_at IS NULL
       ORDER BY c.id, v.created_at DESC, v.id DESC
    ) newest
     WHERE newest.judged ~ '^[0-9a-f]{40}$'
  `)) as unknown as Array<{ issue_id: string; judged: string }>;
  if (rows.length === 0) return [];
  const builds = await landedBuildsOf([...new Set(rows.map((r) => r.issue_id))]);
  const asks: ShippedAsk[] = rows.flatMap((r) => {
    const landing = builds.get(r.issue_id.toLowerCase())?.sha ?? null;
    return landing && landing !== r.judged ? [{ issueId: r.issue_id, landing, sha: r.judged }] : [];
  });
  if (asks.length === 0) return [];
  const landings = asks.map((a) => a.landing);
  const shas = asks.map((a) => a.sha);
  const [marked, shipped, forth, back] = await Promise.all([
    recordedHolding(
      projectId,
      asks.flatMap((a) => [holdingPair(a.landing, a.sha), holdingPair(a.sha, a.landing)]),
    ),
    shippedCommitHolding(projectId, asks),
    persistedCarriage(projectId, landings, shas),
    persistedCarriage(projectId, shas, landings),
  ]);
  return asks.flatMap((a): Owed[] => {
    const markedEither =
      marked.get(pairKey(holdingPair(a.landing, a.sha))) === true ||
      marked.get(pairKey(holdingPair(a.sha, a.landing))) === true;
    const held = shipped.get(shippedAskKey(a));
    const kept = forth.get(carriageKey(a.landing, a.sha));
    if (markedEither || held === true || kept?.kind === 'descends') return [];
    if (held === false || kept?.kind === 'differs') {
      return back.has(carriageKey(a.sha, a.landing)) ? [] : [{ judged: a.sha, served: a.landing }];
    }
    return [{ judged: a.landing, served: a.sha, back: true }];
  });
}

/** `a` and `b` taken in turn, so one budget is spent on both kinds of pair, neither starving. */
function interleaved<T>(a: readonly T[], b: readonly T[]): T[] {
  const out: T[] = [];
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if (i < a.length) out.push(a[i] as T);
    if (i < b.length) out.push(b[i] as T);
  }
  return out;
}

/**
 * Keep that `holder` holds `landing`, as the source host or a box's checkout answered it to a door
 * that asked (`verdict-commit-placement.ts:commitPlacedOnLanding`): ancestry between two named commits
 * never changes, so the read paths answer it from here and ask nothing. Only a `holds` answer is
 * kept, since a row saying it does not names the files the two trees differ in, which no door read.
 */
export async function keepHolding(
  projectId: string,
  landing: string,
  holder: string,
): Promise<void> {
  const judged = lower(landing);
  const served = lower(holder);
  if (judged === served || !WHOLE.test(judged) || !WHOLE.test(served)) return;
  await db
    .insert(servedAncestry)
    .values({
      projectId,
      servedCommit: served,
      judgedCommit: judged,
      carried: true,
      differsIn: null,
    })
    .onConflictDoNothing();
}

// Each pass starts one project further along, so a spent budget is spent elsewhere first next time.
let passes = 0;

/** One pass: read what each project serves, ask for the pairs nothing holds, keep each answer. */
export async function readServedAncestry(): Promise<ServedAncestryPassResult> {
  const result: ServedAncestryPassResult = {
    projects: 0,
    asked: 0,
    written: 0,
    unread: 0,
    derived: 0,
    deferred: 0,
    unreadPairs: [],
  };
  const projects = rotated(await judgedProjects(), passes).slice(0, ANCESTRY_PROJECTS_PER_PASS);
  passes += 1;
  let spent = 0;
  const budget = {
    left: () => spent < ANCESTRY_ASKS_PER_PASS,
    spend: () => {
      spent += 1;
      return spent <= ANCESTRY_ASKS_PER_PASS
        ? null
        : `it was not asked this pass: one pass asks at most ${ANCESTRY_ASKS_PER_PASS} pairs`;
    },
  };
  for (const projectId of projects) {
    if (!budget.left()) break;
    result.projects += 1;
    const { all: served, production } = await servedNow(projectId);
    await keepServedBuilds(projectId, production);
    // whether each live build descends from the one served before is asked first: once it does, what
    // that build held is derived (`served-builds.ts:heldBefore`), one pair a deploy (ISS-1182)
    const bridges = await bridgesOwed(projectId, production);
    // each landing against the commits its verdicts name, in turn with each served commit against
    // them; what a build served before held, once the host answered the live one descends from it, is
    // kept as the live build's own (ISS-1182 round 2)
    const owed = async () => {
      const pairs = served.length > 0 ? await owedPairs(projectId, served, production) : null;
      if (pairs) result.derived += await keepDerived(projectId, pairs.derived);
      return uniquePairs(interleaved(await owedLandingPairs(projectId), pairs?.owed ?? []));
    };
    const first = bridges.length > 0 ? [] : await owed();
    if (bridges.length === 0 && first.length === 0) continue;
    const host = await hostOf(projectId);
    if ('why' in host) {
      result.unread += bridges.length + (bridges.length > 0 ? (await owed()).length : first.length);
      continue;
    }
    await askAndKeep(projectId, host, bridges, result, budget, true);
    await askAndKeep(projectId, host, bridges.length > 0 ? await owed() : first, result, budget);
  }
  if (result.asked > 0 || result.unread > 0 || result.derived > 0) {
    logger.info({ ...result }, 'served-ancestry: what served commits carry, read and kept');
  }
  return result;
}

/** Asks the host each of `pairs` while the pass's budget lasts, and keeps each answer it gives. */
async function askAndKeep(
  projectId: string,
  host: SourceHost,
  pairs: Owed[],
  result: ServedAncestryPassResult,
  budget: { left: () => boolean; spend: () => string | null },
  bridges = false,
): Promise<void> {
  for (let i = 0; i < pairs.length; i += 1) {
    if (!budget.left()) break;
    const pair = pairs[i] as Owed;
    const key = unansweredKey(projectId, pair);
    const missed = UNANSWERED.get(key);
    if (!bridges && missed && missed.next > passes) {
      result.deferred += 1;
      continue;
    }
    const carriage = await carriageOf(host, pair.judged, pair.served, budget.spend);
    result.asked += 1;
    if (carriage.kind === 'unread' || carriage.kind === 'lacks') {
      // a host that did not answer writes nothing: the pair stays unread, asked again later
      result.unread += 1;
      const why = carriage.why;
      if (result.unreadPairs.length < 10)
        result.unreadPairs.push(`${projectId} ${pair.judged}>${pair.served}: ${why}`);
      const misses = (missed?.misses ?? 0) + 1;
      if (UNANSWERED.size >= UNANSWERED_LIMIT) UNANSWERED.clear();
      UNANSWERED.set(key, { misses, next: passes + 2 ** Math.min(misses - 1, 6) });
      continue;
    }
    UNANSWERED.delete(key);
    const carried = carriage.kind === 'descends';
    const written = await db
      .insert(servedAncestry)
      .values({
        projectId,
        servedCommit: pair.served,
        judgedCommit: pair.judged,
        carried,
        differsIn: carried ? null : carriage.paths.slice(),
      })
      .onConflictDoNothing()
      .returning({ projectId: servedAncestry.projectId });
    result.written += written.length;
    const back = carriageKey(pair.served, pair.judged);
    if (pair.back && !carried && !pairs.some((p) => carriageKey(p.judged, p.served) === back)) {
      pairs.push({ judged: pair.served, served: pair.judged });
    }
  }
}
