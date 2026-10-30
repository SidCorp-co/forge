/**
 * Whether what a project serves carries each commit a verdict on it was judged at, asked of the source
 * host once per pair by the pipeline sweep and kept (`served_ancestry`), so a read answers from the
 * row and asks no host (ISS-774), and a deploy empties nothing. On forge-dev every push to `dev`
 * deploys and a `-dev.N` release is only a snapshot (`deploy-dev.yml`), so the commit served is
 * usually one no release recorded and the release records (`recorded-carriage.ts`) cannot place it:
 * every runtime verdict a deploy ago read unread (REQ-79, 2026-10-30).
 *
 * Each pass reads what each project serves (production, and the environment its changes are judged
 * on), and asks for every pair it holds no row and no release record for, newest verdict first. A host
 * that does not answer writes nothing, so the pair stays unread with its reason and the next pass asks
 * again. The work is bounded: at most `ANCESTRY_PROJECTS_PER_PASS` projects are read a pass, and at most
 * `ANCESTRY_ASKS_PER_PASS` pairs not already held are asked of the host across all of them (each one
 * compare, or a compare and the paged file lists where it does not descend); each pass starts one
 * project further along, so a budget a pass spent is spent elsewhere first in the next.
 */

import { servedCommits } from '@forge/contracts/releases';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { servedAncestry } from '../db/schema.js';
import {
  resolveSourceHost,
  type SourceHost,
  SourceHostUnavailable,
} from '../integrations/source-host/index.js';
import { type Carriage, carriageKey, rotated } from '../issues/index.js';
import { logger } from '../lib/logger.js';
import { carriageOf } from './carriage.js';
import { recordedCarriage } from './recorded-carriage.js';
import { readJudgedOnNow, readServingNow } from './serving-reading.js';

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
}

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

/** The whole commits the project's production and judged-on environments answer serving now. */
async function servedNow(projectId: string): Promise<string[]> {
  const production = await readServingNow(projectId);
  const judgedOn = await readJudgedOnNow(projectId);
  const commits = [
    ...servedCommits(production),
    ...(judgedOn.kind === 'read' ? servedCommits(judgedOn.serving) : []),
  ].map(lower);
  return [...new Set(commits.filter((c) => WHOLE.test(c)))];
}

/** What the host answered about each held pair of `judged` × `served`, by `carriageKey`. */
export async function persistedCarriage(
  projectId: string,
  judged: readonly string[],
  served: readonly string[],
): Promise<Map<string, Carriage>> {
  const out = new Map<string, Carriage>();
  const j = [...new Set(judged.map(lower).filter((c) => WHOLE.test(c)))];
  const s = [...new Set(served.map(lower).filter((c) => WHOLE.test(c)))];
  if (j.length === 0 || s.length === 0) return out;
  const rows = await db
    .select()
    .from(servedAncestry)
    .where(
      and(
        eq(servedAncestry.projectId, projectId),
        inArray(servedAncestry.servedCommit, s),
        inArray(servedAncestry.judgedCommit, j),
      ),
    );
  for (const r of rows) {
    out.set(
      carriageKey(r.judgedCommit, r.servedCommit),
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

/** The pairs of one project no row and no release record answers, newest verdict first. */
async function owedPairs(projectId: string, served: readonly string[]) {
  const judged = await judgedCommitsOf(projectId);
  const [held, recorded] = await Promise.all([
    persistedCarriage(projectId, judged, served),
    recordedCarriage(projectId, judged, served),
  ]);
  return judged.flatMap((j) =>
    served
      .filter((s) => s !== j && !held.has(carriageKey(j, s)) && !recorded.has(carriageKey(j, s)))
      .map((s) => ({ judged: j, served: s })),
  );
}

// Each pass starts one project further along, so a spent budget is spent elsewhere first next time.
let passes = 0;

/** One pass: read what each project serves, ask for the pairs nothing holds, keep each answer. */
export async function readServedAncestry(): Promise<ServedAncestryPassResult> {
  const result: ServedAncestryPassResult = { projects: 0, asked: 0, written: 0, unread: 0 };
  const projects = rotated(await judgedProjects(), passes).slice(0, ANCESTRY_PROJECTS_PER_PASS);
  passes += 1;
  let spent = 0;
  const spend = () => {
    spent += 1;
    return spent <= ANCESTRY_ASKS_PER_PASS
      ? null
      : `it was not asked this pass: one pass asks at most ${ANCESTRY_ASKS_PER_PASS} pairs`;
  };
  for (const projectId of projects) {
    if (spent >= ANCESTRY_ASKS_PER_PASS) break;
    result.projects += 1;
    const served = await servedNow(projectId);
    if (served.length === 0) continue;
    const pairs = await owedPairs(projectId, served);
    if (pairs.length === 0) continue;
    const host = await hostOf(projectId);
    if ('why' in host) {
      result.unread += pairs.length;
      continue;
    }
    for (const pair of pairs) {
      if (spent >= ANCESTRY_ASKS_PER_PASS) break;
      const carriage = await carriageOf(host, pair.judged, pair.served, spend);
      result.asked += 1;
      if (carriage.kind === 'unread' || carriage.kind === 'lacks') {
        // a host that did not answer writes nothing: the pair stays unread and is asked again
        result.unread += 1;
        continue;
      }
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
    }
  }
  if (result.asked > 0 || result.unread > 0) {
    logger.info({ ...result }, 'served-ancestry: what served commits carry, read and kept');
  }
  return result;
}
