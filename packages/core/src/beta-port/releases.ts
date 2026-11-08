// The release half of a beta port fire (ISS-988, owner 2026-11-05 `owner-2026-11-05-dev-runs-beta-
// releases`: a release a beta user presses is dev's to run, and beta is told how it went, since beta's
// users know only beta). On each fire, every release pressed on a beta twin project since the port's
// high-water mark there is taken once (`release-store.ts`), and each beta issue it carries is mapped
// to its dev twin, or to the issues its Feedback item's triage routed to. A beta issue with neither
// is named, never skipped. Once every dev issue stands at dev's release gate, dev's own release door
// cuts the release, named for the beta release (`ReleaseDoor`); the dev master runs it with the dev
// project's own promotion and deployment, and the port deploys nothing. Once that dev release ships
// or fails, the beta release is ended on beta with a reason naming it, and each beta issue is told
// its outcome by one comment; the close of a shipped issue is the mirror's, by that dev release
// (`mirror.ts:closeByRelease`), forward only as every mirror move. Nothing here moves a beta status.

import type { ReleaseNaming } from '@forge/contracts/release-notes';
import {
  endPeerRelease,
  listPeerPressedReleases,
  type PeerForge,
  type PeerRelease,
  postPeerComment,
} from '../integrations/peer-forge/index.js';
import { triageOutcomesOf } from './ports.js';
import {
  devReleaseStanding,
  openReleasesOf,
  releaseMarkOf,
  type TakenRelease,
  takeRelease,
  updateRelease,
} from './release-store.js';
import type { BetaPortReport } from './report.js';
import { type DevTwin, devIssuesById, pairsOf } from './store.js';

/** The ask a beta release is cut on dev with: dev's own release door, as the twin's owner. */
export interface ReleaseCutAsk {
  projectId: string;
  issueIds: string[];
  userId: string;
  naming: ReleaseNaming;
}

/** What dev's release door answered: the run it cut, or the refusal it met, by code. */
export type ReleaseCut = { ok: true; runId: string } | { ok: false; code: string; detail: string };

/** Dev's release door (`release-batch/create.ts:createReleaseBatch`), handed in by the fire. */
export type ReleaseDoor = (ask: ReleaseCutAsk) => Promise<ReleaseCut>;

/** What the release half of a fire reads and writes. */
export interface ReleaseContext {
  peer: PeerForge;
  report: BetaPortReport;
  /** The owner's ruling: no release pressed before it is taken. */
  cutoff: Date;
  door: ReleaseDoor;
}

/** The dev release gate a cut takes its roster from. */
const DEV_RELEASE_GATE = 'awaiting_release';

/** A beta issue left out of its release's dev roster, named with why. */
const noTwinLine = (key: string, why: string) => `beta ${key} (${why})`;
const isNoTwinOf = (key: string) => (line: string) => line.startsWith(`beta ${key} (`);

const betaName = (r: { betaVersion: string | null; betaRunId: string }) =>
  `forge-beta release ${r.betaVersion ?? '(no version)'} (${r.betaRunId})`;

/**
 * The name and summary a dev release cut for a beta release carries: the beta release by version
 * and id, how many dev issues it carries, and each beta issue it leaves out for want of a dev twin.
 */
export function betaReleaseNaming(args: {
  slug: string;
  betaVersion: string | null;
  betaRunId: string;
  devIssues: number;
  noTwin: readonly string[];
}): ReleaseNaming {
  const left =
    args.noTwin.length > 0 ? `; left out, with no dev twin: ${args.noTwin.join('; ')}` : '';
  const summary = `Run on dev for ${betaName(args)} of ${args.slug}. It carries ${args.devIssues} dev issue${args.devIssues === 1 ? '' : 's'}${left}.`;
  return {
    name: `Beta ${args.betaVersion ?? 'release'} on dev`.slice(0, 60),
    summary: summary.length <= 600 ? summary : `${summary.slice(0, 597)}...`,
  };
}

/** The reason a beta release is ended with on beta: the log line its release keeps. */
export function betaEndReason(slug: string, devVersion: string, shipped: boolean): string {
  return shipped
    ? `Run on forge-dev as ${slug} ${devVersion}, which shipped; each issue it carries closes by that release.`
    : `Run on forge-dev as ${slug} ${devVersion}, which failed; nothing was released.`;
}

/** The one line each beta issue of a settled beta release is told. */
export function betaIssueOutcomeLine(args: {
  slug: string;
  devVersion: string;
  betaVersion: string | null;
  shipped: boolean;
  twinned: boolean;
}): string {
  const of = `forge-dev release ${args.slug} ${args.devVersion}, run for forge-beta release ${args.betaVersion ?? '(no version)'}`;
  if (!args.twinned) {
    return `${of}, ${args.shipped ? 'shipped' : 'failed'} without this issue: it has no dev twin.`;
  }
  return args.shipped
    ? `Released by ${of}; this issue closes by that release.`
    : `Not released: ${of} failed, and this issue stays where it is.`;
}

/**
 * The dev issues the beta issues of one release map to, and each beta issue with none, named with
 * why: a twin pair names its dev issue, a Feedback pair the issues its item's triage routed to.
 */
async function devSideOf(
  release: PeerRelease,
): Promise<{ devIssueIds: string[]; noTwin: string[] }> {
  const pairs = await pairsOf(release.issues.map((i) => i.id));
  const feedbackIds = [...pairs.values()]
    .map((p) => p.devFeedbackId)
    .filter((id): id is string => id !== null);
  const triages = feedbackIds.length > 0 ? await triageOutcomesOf(feedbackIds) : new Map();
  const devIssueIds = new Set<string>();
  const noTwin: string[] = [];
  for (const issue of release.issues) {
    const pair = pairs.get(issue.id);
    if (!pair) {
      noTwin.push(noTwinLine(issue.key, 'never ported to dev'));
      continue;
    }
    if (pair.devIssueId) {
      devIssueIds.add(pair.devIssueId);
      continue;
    }
    const triage = triages.get(pair.devFeedbackId as string);
    if (!triage || triage.issueIds.length === 0) {
      noTwin.push(
        noTwinLine(
          issue.key,
          `ported as ${triage?.key ?? 'a Feedback item'}, which routes to no dev issue`,
        ),
      );
      continue;
    }
    for (const id of triage.issueIds) devIssueIds.add(id);
  }
  return { devIssueIds: [...devIssueIds], noTwin };
}

/** Every release pressed on one beta project since the port's mark there, taken once. */
async function takeNewReleases(
  ctx: ReleaseContext,
  betaProjectId: string,
  twin: DevTwin,
): Promise<void> {
  const mark = await releaseMarkOf(twin.slug);
  const since = mark && mark > ctx.cutoff ? mark : ctx.cutoff;
  const listed = await listPeerPressedReleases(ctx.peer, betaProjectId, since);
  if (!listed.ok) {
    ctx.report.refused.push(
      `${twin.slug} releases: ${listed.refusal.code} (${listed.refusal.detail}); none taken this fire`,
    );
    return;
  }
  for (const release of listed.value) {
    const { devIssueIds, noTwin } = await devSideOf(release);
    const state = devIssueIds.length === 0 ? 'no_twin' : 'waiting';
    const taken = await takeRelease({
      betaRunId: release.runId,
      betaProjectId,
      betaProjectSlug: twin.slug,
      betaVersion: release.version,
      betaStartedAt: release.startedAt,
      betaIssues: release.issues.map((i) => ({ id: i.id, key: i.key })),
      devProjectId: twin.id,
      devIssueIds,
      noTwin,
      state,
    });
    if (!taken) continue;
    const named = betaName({ betaVersion: release.version, betaRunId: release.runId });
    for (const line of noTwin) ctx.report.releaseNoTwin.push(`${twin.slug}: ${named}: ${line}`);
    ctx.report.releases.push(
      state === 'no_twin'
        ? `${twin.slug}: ${named} taken: no beta issue it carries has a dev twin, so nothing is cut`
        : `${twin.slug}: ${named} taken, carrying ${devIssueIds.length} dev issue${devIssueIds.length === 1 ? '' : 's'}`,
    );
  }
}

/**
 * A release whose dev issues all stand at dev's release gate, cut by dev's own door and named for
 * the beta release; one whose issues do not is left waiting, naming each that is not ready, and is
 * read again next fire. A partial roster is never cut.
 */
async function requestOnDev(
  ctx: ReleaseContext,
  twin: DevTwin,
  release: TakenRelease,
): Promise<void> {
  const named = betaName(release);
  const devs = await devIssuesById(twin, release.devIssueIds);
  const notReady = release.devIssueIds
    .map((id) => devs.get(id))
    .flatMap((d) => (d && d.status !== DEV_RELEASE_GATE ? [`${d.key} at ${d.status}`] : []));
  const gone = release.devIssueIds.filter((id) => !devs.has(id));
  if (notReady.length > 0 || gone.length > 0) {
    const said = `not every dev issue is at ${DEV_RELEASE_GATE}: ${[...notReady, ...gone.map((id) => `${id} no longer exists`)].join(', ')}`;
    if (said !== release.said) await updateRelease(release.id, { said });
    ctx.report.releasesWaiting.push(`${twin.slug}: ${named}: ${said}; nothing cut`);
    return;
  }
  const cut = await ctx.door({
    projectId: twin.id,
    issueIds: release.devIssueIds,
    userId: twin.createdBy,
    naming: betaReleaseNaming({
      slug: twin.slug,
      betaVersion: release.betaVersion,
      betaRunId: release.betaRunId,
      devIssues: release.devIssueIds.length,
      noTwin: release.noTwin,
    }),
  });
  if (!cut.ok) {
    const said = `dev's release door refused the cut ${cut.code}: ${cut.detail}`;
    await updateRelease(release.id, { said });
    ctx.report.refused.push(`${twin.slug}: ${named}: ${said}; tried again next fire`);
    return;
  }
  const standing = await devReleaseStanding(twin.id, cut.runId);
  const version = standing?.version ?? null;
  await updateRelease(release.id, {
    state: 'requested',
    said: null,
    devRunId: cut.runId,
    devVersion: version,
  });
  ctx.report.releases.push(
    `${twin.slug}: ${named} requested on dev as ${version ?? cut.runId}, carrying ${release.devIssueIds.length} dev issue${release.devIssueIds.length === 1 ? '' : 's'}`,
  );
}

/**
 * The outcome of a settled dev release written back on beta, once: the beta release ended with a
 * reason naming the dev release, and each beta issue told it by one comment. A refusal beta answers
 * for the end (it may have ended the release itself) is recorded and not asked again; a refusal of
 * a comment, or a beta that could not be reached, is tried again next fire. Each step is recorded as
 * it is taken, so none is made twice.
 */
async function writeBack(
  ctx: ReleaseContext,
  twin: DevTwin,
  release: TakenRelease,
  devVersion: string,
  shipped: boolean,
): Promise<void> {
  const named = betaName(release);
  let complete = true;
  if (release.betaEnded === null) {
    const ended = await endPeerRelease(
      ctx.peer,
      release.betaProjectId,
      release.betaRunId,
      betaEndReason(twin.slug, devVersion, shipped),
    );
    if (ended.ok) {
      await updateRelease(release.id, { betaEnded: 'ended' });
    } else if (ended.refusal.status === 0 || ended.refusal.status >= 500) {
      complete = false;
      ctx.report.refused.push(
        `${twin.slug}: ending ${named} on beta: ${ended.refusal.code}; tried again next fire`,
      );
    } else {
      await updateRelease(release.id, { betaEnded: `refused ${ended.refusal.code}` });
      ctx.report.refused.push(
        `${twin.slug}: ending ${named} on beta: ${ended.refusal.code} (${ended.refusal.detail}); not asked again`,
      );
    }
  }
  const told = [...release.told];
  for (const issue of release.betaIssues) {
    if (told.includes(issue.id)) continue;
    const said = await postPeerComment(
      ctx.peer,
      issue.id,
      betaIssueOutcomeLine({
        slug: twin.slug,
        devVersion,
        betaVersion: release.betaVersion,
        shipped,
        twinned: !release.noTwin.some(isNoTwinOf(issue.key)),
      }),
    );
    if (!said.ok) {
      complete = false;
      ctx.report.refused.push(
        `${twin.slug}: beta ${issue.key} outcome of ${devVersion}: ${said.refusal.code}; tried again next fire`,
      );
      continue;
    }
    told.push(issue.id);
    await updateRelease(release.id, { told });
  }
  if (!complete) return;
  await updateRelease(release.id, { writtenBackAt: new Date() });
  ctx.report.releases.push(
    `${twin.slug}: ${named}: dev ${devVersion} ${shipped ? 'shipped' : 'failed'}, written back on beta`,
  );
}

/** A requested release whose dev release settled, written back; one still open waits on dev. */
async function settle(ctx: ReleaseContext, twin: DevTwin, release: TakenRelease): Promise<void> {
  const named = betaName(release);
  let state = release.state;
  let version = release.devVersion;
  if (state === 'requested') {
    const standing = await devReleaseStanding(twin.id, release.devRunId as string);
    if (!standing) {
      ctx.report.refused.push(
        `${twin.slug}: ${named}: BETA_PORT_DEV_RELEASE_GONE: dev release run ${release.devRunId} no longer reads as a release; nothing written back`,
      );
      return;
    }
    if (standing.outcome === 'open') return;
    state = standing.outcome;
    version = standing.version;
    await updateRelease(release.id, { state, devVersion: version });
  }
  await writeBack(ctx, twin, release, version ?? (release.devRunId as string), state === 'shipped');
}

/** The release half of one beta project's fire: new releases taken, and every open one moved on. */
export async function bridgeReleases(
  ctx: ReleaseContext,
  betaProjectId: string,
  twin: DevTwin,
): Promise<void> {
  await takeNewReleases(ctx, betaProjectId, twin);
  for (const release of await openReleasesOf(twin.slug)) {
    if (release.state === 'waiting') await requestOnDev(ctx, twin, release);
    else await settle(ctx, twin, release);
  }
}
