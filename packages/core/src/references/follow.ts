// Following a source's releases (ISS-1252). Each followed github.com repository is read once a pass,
// asked with the ETag of the last read; the releases newer than the tag last seen are digested
// against each reading project's open issues and requirements. One that touches an open problem
// files an idea in the project's Product (feedback kind `idea`, on that item, the release named),
// joined by its signal key so a second read files nothing again; every other release is kept on the
// source's timeline and posts nothing. A spent rate limit ends the pass by name, never retried.

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
import { freshReleases, matchRelease, type OpenItem } from './match.js';
import { openItemsOf } from './open-items.js';
import { orgOfProject, type SourceRow, sourceIn } from './read.js';

/** Reads a repository's releases: the GitHub port, or a fixture in a test. */
export type ReleaseReader = (repo: string, etag: string | null) => Promise<FollowedRead>;

const NOTES_CHARS = 1500;
const TITLE_CHARS = 200;

export interface FollowOutcome {
  source: string;
  act: 'digested' | 'unchanged' | 'failed' | 'skipped';
  ideas: string[];
  silent: number;
  /** Why it failed, or when GitHub's limit resets. */
  said?: string;
  resetsAt?: string | null;
}

function ideaBody(source: SourceRow, release: FollowedRelease, item: OpenItem, terms: string[]) {
  const notes = release.body.trim().slice(0, NOTES_CHARS);
  return [
    `${source.title} published ${release.name ?? release.tag} (${release.url}).`,
    `It may help with ${item.ref}: ${item.title}. Both name: ${terms.join(', ')}.`,
    `Followed because: ${source.why}`,
    notes ? `Release notes, as published:\n\n${notes}` : '',
    'Read the release itself, then take or reject it and say why (references.cite).',
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** One release digested for one project: an idea on the item it may help, or a silent row. */
async function digestOne(
  source: SourceRow,
  projectId: string,
  items: readonly OpenItem[],
  release: FollowedRelease,
): Promise<{ idea: string | null } | null> {
  const [held] = await db
    .select({ id: referenceReleases.id })
    .from(referenceReleases)
    .where(
      and(
        eq(referenceReleases.sourceId, source.id),
        eq(referenceReleases.projectId, projectId),
        eq(referenceReleases.tag, release.tag),
      ),
    );
  if (held) return null;
  const match = matchRelease(release, items, source.areas);
  let feedbackId: string | null = null;
  let idea: string | null = null;
  if (match) {
    const agent = await db.transaction((tx) => resolveProjectHandle(tx, projectId));
    const filed = await fileSignalFeedback({
      projectId,
      actor: { userId: agent.userId, agency: 'agent' },
      request: {
        kind: 'idea',
        title:
          `${source.title} ${release.tag} may help with ${match.item.ref}: ${match.item.title}`.slice(
            0,
            TITLE_CHARS,
          ),
        body: ideaBody(source, release, match.item, match.terms),
        severity: 'low',
        ...(match.item.kind === 'issue'
          ? { issue: match.item.id }
          : { requirement: match.item.id }),
      },
      signalKey: referenceSignalKey(source.id, release.tag),
      source: { projectId, issueId: null, runId: null, clientVersion: null },
      said: `Read from ${release.url}.`,
    });
    if (!filed.ok) {
      throw new Error(
        `references: the idea from ${source.title} ${release.tag} was refused: ${filed.refusals.map((r) => `${r.code} ${r.detail}`).join('; ')}`,
      );
    }
    feedbackId = filed.id;
    idea = filed.key;
  }
  await db
    .insert(referenceReleases)
    .values({
      projectId,
      sourceId: source.id,
      tag: release.tag,
      name: release.name,
      url: release.url,
      publishedAt: release.publishedAt ? new Date(release.publishedAt) : null,
      outcome: match ? 'idea' : 'silent',
      matchedRef: match?.item.ref ?? null,
      matchedTerms: match?.terms ?? null,
      feedbackId,
    })
    .onConflictDoNothing();
  return { idea };
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
  items: (projectId: string) => Promise<OpenItem[]> = openItemsOf,
): Promise<FollowOutcome> {
  const base = { source: source.title, ideas: [] as string[], silent: 0 };
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
    const open = await items(projectId);
    for (const release of fresh) {
      const done = await digestOne(source, projectId, open, release);
      if (!done) continue;
      if (done.idea) out.ideas.push(done.idea);
      else out.silent += 1;
    }
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
    return { source: source.title, act: 'failed', ideas: [], silent: 0, said };
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
  failed: number;
  stopped: string | null;
}> {
  const sources = await db
    .select()
    .from(referenceSources)
    .where(and(eq(referenceSources.followReleases, true), isNull(referenceSources.removedAt)))
    .orderBy(sql`${referenceSources.lastCheckedAt} ASC NULLS FIRST`);
  const tally = { read: 0, ideas: 0, silent: 0, failed: 0, stopped: null as string | null };
  for (const source of sources) {
    const one = await followIsolated(source, read, now);
    tally.read += 1;
    tally.ideas += one.ideas.length;
    tally.silent += one.silent;
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
      said: 'its releases are not followed; set followReleases true to follow them',
    };
  }
  return followSource(source);
}

/** The timer's run: the pass over every followed source, logged when it read or stopped on anything. */
export async function followReferences(): Promise<void> {
  const tally = await followAllSources();
  if (tally.read > 0 || tally.stopped) logger.info(tally, 'reference-releases: read');
}
