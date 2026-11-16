// Following a source's releases (ISS-1252). Each followed github.com repository is read once a pass,
// asked with the ETag of the last read; the releases newer than the tag last seen are digested
// against each reading project's open issues and requirements (`match.ts`: the nearest by meaning,
// judged by the fast model). Releases of one source that help the same open item in one pass file
// ONE idea in the project's Product (feedback kind `idea`, on that item, the newest release named and
// the others listed), joined by its signal key so a second read files nothing again; each release is
// kept on the source's timeline, the helping ones recorded against that idea. A release no vector or
// no model can judge stays silent, and the pass says why by name. A spent rate limit ends the pass by
// name, never retried.

import { githubRepoOf, referenceSignalKey } from '@forge/contracts/references';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { resolveProjectHandle } from '../conversations/index.js';
import { db } from '../db/client.js';
import { referenceReleases, referenceSources } from '../db/schema-references.js';
import { fileSignalFeedback } from '../feedback/index.js';
import {
  type FollowedRead,
  type FollowedRelease,
  readFollowedRepo,
} from '../integrations/github/index.js';
import { reportFailure } from '../lib/error-tracking.js';
import { logger } from '../lib/logger.js';
import { listOrgProjects } from '../orgs/index.js';
import {
  freshReleases,
  type JudgeRelease,
  matchRelease,
  type NearestOpen,
  type OpenItem,
  type ReleaseMatch,
} from './match.js';
import { openItemsOf } from './open-items.js';
import { orgOfProject, type SourceRow, sourceIn } from './read.js';
import { judgeRelease, nearestOpenItems } from './release-judge.js';

/** Reads a repository's releases: the GitHub port, or a fixture in a test. */
export type ReleaseReader = (repo: string, etag: string | null) => Promise<FollowedRead>;

/** What a pass reads open items and matches by: core's own, or a test's stand-ins. */
export interface FollowPorts {
  items: (projectId: string) => Promise<OpenItem[]>;
  nearest: NearestOpen;
  judge: JudgeRelease;
}

const CORE_PORTS: FollowPorts = {
  items: openItemsOf,
  nearest: nearestOpenItems,
  judge: judgeRelease,
};

const NOTES_CHARS = 1500;
const TITLE_CHARS = 200;

export interface FollowOutcome {
  source: string;
  act: 'digested' | 'unchanged' | 'failed' | 'skipped';
  ideas: string[];
  silent: number;
  /** Releases kept silent because no vector or no model could judge them; `said` names why. */
  unjudged: number;
  /** Why it failed or was skipped, or why releases went unjudged. */
  said?: string;
  resetsAt?: string | null;
}

type Helping = { release: FollowedRelease; why: string };

function ideaBody(source: SourceRow, item: OpenItem, helping: readonly Helping[]) {
  const newest = helping[helping.length - 1] as Helping;
  const earlier = helping.slice(0, -1);
  const notes = newest.release.body.trim().slice(0, NOTES_CHARS);
  return [
    `${source.title} published ${newest.release.name ?? newest.release.tag} (${newest.release.url}).`,
    `It may help with ${item.ref}: ${item.title}. ${newest.why}`,
    earlier.length
      ? `Earlier releases read in the same pass help with it too:\n${earlier.map((h) => `- ${h.release.name ?? h.release.tag} (${h.release.url}): ${h.why}`).join('\n')}`
      : '',
    `Followed because: ${source.why}`,
    notes ? `Release notes, as published:\n\n${notes}` : '',
    'Read the release itself, then take or reject it and say why (references.cite).',
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** One idea for the releases of one pass that help `item`, named by the newest; its FB key and id. */
async function fileIdea(
  source: SourceRow,
  projectId: string,
  item: OpenItem,
  helping: readonly Helping[],
): Promise<{ id: string; key: string }> {
  const newest = (helping[helping.length - 1] as Helping).release;
  const agent = await db.transaction((tx) => resolveProjectHandle(tx, projectId));
  const filed = await fileSignalFeedback({
    projectId,
    actor: { userId: agent.userId, agency: 'agent' },
    request: {
      kind: 'idea',
      title: `${source.title} ${newest.tag} may help with ${item.ref}: ${item.title}`.slice(
        0,
        TITLE_CHARS,
      ),
      body: ideaBody(source, item, helping),
      severity: 'low',
      ...(item.kind === 'issue' ? { issue: item.id } : { requirement: item.id }),
    },
    signalKey: referenceSignalKey(source.id, newest.tag),
    source: { projectId, issueId: null, runId: null, clientVersion: null },
    said: `Read from ${newest.url}.`,
  });
  if (!filed.ok) {
    throw new Error(
      `references: the idea from ${source.title} ${newest.tag} was refused: ${filed.refusals.map((r) => `${r.code} ${r.detail}`).join('; ')}`,
    );
  }
  return { id: filed.id, key: filed.key };
}

/** A release as the timeline keeps it: the idea it helps with, or silent with why it was not judged. */
async function record(
  source: SourceRow,
  projectId: string,
  release: FollowedRelease,
  kept: { idea: { ref: string; why: string; feedbackId: string } } | { silent: string | null },
) {
  const idea = 'idea' in kept ? kept.idea : null;
  await db
    .insert(referenceReleases)
    .values({
      projectId,
      sourceId: source.id,
      tag: release.tag,
      name: release.name,
      url: release.url,
      publishedAt: release.publishedAt ? new Date(release.publishedAt) : null,
      outcome: idea ? 'idea' : 'silent',
      matchedRef: idea?.ref ?? null,
      why: idea ? idea.why : 'silent' in kept ? kept.silent : null,
      feedbackId: idea?.feedbackId ?? null,
    })
    .onConflictDoNothing();
}

/** Whether the project already read `release` from `source`. */
async function held(source: SourceRow, projectId: string, release: FollowedRelease) {
  const [row] = await db
    .select({ id: referenceReleases.id })
    .from(referenceReleases)
    .where(
      and(
        eq(referenceReleases.sourceId, source.id),
        eq(referenceReleases.projectId, projectId),
        eq(referenceReleases.tag, release.tag),
      ),
    );
  return Boolean(row);
}

/**
 * One project's digest of a pass's fresh releases, oldest first: each judged, then one idea per open
 * item the releases help, every release kept on the timeline.
 */
async function digestFor(
  source: SourceRow,
  projectId: string,
  fresh: readonly FollowedRelease[],
  ports: FollowPorts,
  out: FollowOutcome,
): Promise<void> {
  const open = await ports.items(projectId);
  const byItem = new Map<string, { item: OpenItem; helping: Helping[] }>();
  const unjudged: string[] = [];
  for (const release of fresh) {
    if (await held(source, projectId, release)) continue;
    const match: ReleaseMatch = await matchRelease(
      projectId,
      { ...release, source: source.title },
      open,
      ports,
    );
    if (match.kind === 'helps') {
      const group = byItem.get(match.item.id) ?? { item: match.item, helping: [] };
      group.helping.push({ release, why: match.why });
      byItem.set(match.item.id, group);
      continue;
    }
    const silent = match.kind === 'unjudged' ? match.why : null;
    if (silent) unjudged.push(`${release.tag}: ${silent}`);
    await record(source, projectId, release, { silent });
    out.silent += 1;
  }
  for (const { item, helping } of byItem.values()) {
    const idea = await fileIdea(source, projectId, item, helping);
    for (const h of helping) {
      await record(source, projectId, h.release, {
        idea: { ref: item.ref, why: h.why, feedbackId: idea.id },
      });
    }
    out.ideas.push(idea.key);
  }
  if (unjudged.length > 0) {
    out.unjudged += unjudged.length;
    const said = `${unjudged.length} release(s) kept silent, not judged: ${unjudged.join('; ')}`;
    out.said = out.said ? `${out.said}; ${said}` : said;
  }
}

/** The projects that read `source`: its own, or every live project of its org. */
async function readersOf(source: SourceRow): Promise<string[]> {
  if (source.projectId) return [source.projectId];
  return (await listOrgProjects(source.orgId)).filter((p) => !p.archivedAt).map((p) => p.id);
}

const settle = (id: string, set: Partial<typeof referenceSources.$inferInsert>) =>
  db.update(referenceSources).set(set).where(eq(referenceSources.id, id));

/** Reads one followed source's releases and digests what is new for every project reading it. */
export async function followSource(
  source: SourceRow,
  read: ReleaseReader = readFollowedRepo,
  now: Date = new Date(),
  ports: FollowPorts = CORE_PORTS,
): Promise<FollowOutcome> {
  const base = { source: source.title, ideas: [] as string[], silent: 0, unjudged: 0 };
  const repo = githubRepoOf(source.url);
  if (!repo) {
    const said = 'only a github.com repository is followed';
    await settle(source.id, { lastCheckedAt: now, followError: said });
    return { ...base, act: 'skipped', said };
  }
  const got = await read(repo, source.followEtag);
  if (!got.ok) {
    await settle(source.id, { lastCheckedAt: now, followError: got.reason });
    return { ...base, act: 'failed', said: got.reason, resetsAt: got.resetsAt };
  }
  const facts = {
    lastCheckedAt: now,
    followError: null,
    repoArchived: got.repo.archived,
    repoPushedAt: got.repo.pushedAt ? new Date(got.repo.pushedAt) : null,
  };
  if (got.unchanged) {
    await settle(source.id, facts);
    return { ...base, act: 'unchanged' };
  }
  const fresh = freshReleases(got.releases, source.lastSeenTag, now);
  const out: FollowOutcome = { ...base, act: 'digested' };
  for (const projectId of await readersOf(source)) {
    await digestFor(source, projectId, fresh, ports, out);
  }
  const newest = got.releases[0];
  await settle(source.id, {
    ...facts,
    followEtag: got.etag,
    ...(newest
      ? {
          lastSeenTag: newest.tag,
          lastReleaseAt: newest.publishedAt ? new Date(newest.publishedAt) : source.lastReleaseAt,
        }
      : {}),
  });
  return out;
}

/**
 * One source of the pass. A source that throws (a read timed out, an idea refused) is settled with
 * its error and reported, so it is not read first again with its error unrecorded, starving every
 * source behind it; the pass goes on to the next.
 */
async function followIsolated(
  source: SourceRow,
  read: ReleaseReader,
  now: Date,
): Promise<FollowOutcome> {
  try {
    return await followSource(source, read, now);
  } catch (err) {
    const said = err instanceof Error ? err.message : String(err);
    logger.error({ err, source: source.id }, `reference-releases: ${source.title} threw`);
    reportFailure(err, { tags: { area: 'reference-releases' }, extra: { source: source.id } });
    await settle(source.id, { lastCheckedAt: now, followError: said });
    return { source: source.title, act: 'failed', ideas: [], silent: 0, unjudged: 0, said };
  }
}

/**
 * The scheduled pass (`timer-registry.ts`, `reference-releases`): every active followed source, the
 * least recently read first, until GitHub's rate limit is spent.
 */
export async function followAllSources(
  read: ReleaseReader = readFollowedRepo,
  now: Date = new Date(),
): Promise<{
  read: number;
  ideas: number;
  silent: number;
  unjudged: number;
  failed: number;
  stopped: string | null;
  /** Why releases went unjudged, by source. */
  notJudged: string[];
}> {
  const sources = await db
    .select()
    .from(referenceSources)
    .where(and(eq(referenceSources.followReleases, true), isNull(referenceSources.removedAt)))
    .orderBy(sql`${referenceSources.lastCheckedAt} ASC NULLS FIRST`);
  const tally = {
    read: 0,
    ideas: 0,
    silent: 0,
    unjudged: 0,
    failed: 0,
    stopped: null as string | null,
    notJudged: [] as string[],
  };
  for (const source of sources) {
    const one = await followIsolated(source, read, now);
    tally.read += 1;
    tally.ideas += one.ideas.length;
    tally.silent += one.silent;
    if (one.unjudged > 0) {
      tally.unjudged += one.unjudged;
      tally.notJudged.push(`${one.source}: ${one.said ?? ''}`);
    }
    if (one.act === 'failed') tally.failed += 1;
    if (one.resetsAt) {
      tally.stopped = one.said ?? 'rate limit spent';
      break;
    }
  }
  return tally;
}

/** `POST …/reference-sources/:source/follow`: reads one followed source now, as the pass would. */
export async function followNow(projectId: string, ref: string): Promise<FollowOutcome> {
  const orgId = await orgOfProject(projectId);
  const source = await sourceIn(db, projectId, orgId, ref);
  if (!source.followReleases) {
    return {
      source: source.title,
      act: 'skipped',
      ideas: [],
      silent: 0,
      unjudged: 0,
      said: 'its releases are not followed; set followReleases true to follow them',
    };
  }
  return followSource(source);
}

/** The timer's run: the pass over every followed source, logged when it read or stopped on anything. */
export async function followReferences(): Promise<void> {
  const tally = await followAllSources();
  if (tally.unjudged > 0)
    logger.warn(tally, 'reference-releases: releases kept silent, not judged');
  else if (tally.read > 0 || tally.stopped) logger.info(tally, 'reference-releases: read');
}
