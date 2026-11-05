// The mirror half of a beta port fire (ISS-923): each ported pair's dev status, tried onto its beta
// issue once, and never backward (ISS-982: `markers.ts:BETA_PORT_PROGRESS` is the order). A pair
// ported as Feedback follows the issues its triage routed to once they land, or is told its outcome.
// A move beta takes is reported, at the status beta stored; a move beta refuses outright is commented
// there once. A close is beta's by a release (ISS-1005): where beta refuses a plain close, its merge
// mark is sent in the beta project's landing shape, and the dev release that closed the twin is
// recorded on beta, which closes it (`closeOnBeta`); where beta refuses that too, the beta issue
// stands at the nearest status it takes, the refusal is commented there once, and the close is tried
// again at every fire until beta takes it. Each try is recorded on the pair with the status beta
// stood at after it, so nothing claims a status beta never took.

import {
  markPeerIssueLanded,
  type PeerAnswer,
  type PeerForge,
  type PeerIssue,
  type PeerLanding,
  postPeerComment,
  readPeerLanding,
  readPeerReleaseNoted,
  recordPeerRelease,
  transitionPeerIssue,
  writePeerReleaseNote,
} from '../integrations/peer-forge/index.js';
import {
  betaReleaseNote,
  closeRefusedComment,
  type FeedbackTold,
  feedbackMirroredComment,
  feedbackToldComment,
  hasLanded,
  landingMark,
  mirrorReason,
  mirrorRefusedComment,
  mirrorTarget,
  movesBackward,
  nearestReason,
  owesTry,
  progressOf,
  releaseRecordAccount,
  releaseRecordRef,
} from './markers.js';
import { type PortedTriage, triageOutcomesOf } from './ports.js';
import type { BetaPortReport } from './report.js';
import {
  type DevRelease,
  type DevTwin,
  devIssuesById,
  devReleasesOf,
  type MirroredDevIssue,
  type Pair,
  recordTold,
  recordTry,
} from './store.js';

/** What the mirror half of a fire reads and writes: beta, the report, and the fire's mirror bound. */
export interface MirrorContext {
  peer: PeerForge;
  report: BetaPortReport;
  budget: { mirrors: number };
}

/**
 * One beta project and its dev twin, with its landing shape and the twin's releases each read at
 * most once per fire, and only where a close needs them.
 */
interface MirrorProject {
  twin: DevTwin;
  betaProjectId: string;
  landing: () => Promise<PeerAnswer<PeerLanding>>;
  releases: () => Promise<DevRelease[]>;
}

/** One try's outcome: the beta status after it, and the close refusal it commented on beta. */
interface Tried {
  reached: string;
  closeRefused?: string;
}

export async function mirrorProject(
  ctx: MirrorContext,
  where: { betaProjectId: string; twin: DevTwin },
  betaIssues: readonly PeerIssue[],
  pairs: ReadonlyMap<string, Pair>,
): Promise<void> {
  const { twin } = where;
  let landing: Promise<PeerAnswer<PeerLanding>> | null = null;
  let releases: Promise<DevRelease[]> | null = null;
  const project: MirrorProject = {
    twin,
    betaProjectId: where.betaProjectId,
    landing: () => {
      landing ??= readPeerLanding(ctx.peer, where.betaProjectId);
      return landing;
    },
    releases: () => {
      releases ??= devReleasesOf(twin);
      return releases;
    },
  };
  const betaById = new Map(betaIssues.map((i) => [i.id, i]));
  const live = [...pairs.values()].filter((p) => betaById.has(p.betaIssueId));
  const twins = live.filter((p) => p.devIssueId !== null);
  const devs = await devIssuesById(
    twin,
    twins.map((p) => p.devIssueId as string),
  );
  for (const pair of twins) {
    const beta = betaById.get(pair.betaIssueId) as PeerIssue;
    const dev = devs.get(pair.devIssueId as string);
    if (dev) await mirrorPair(ctx, project, pair, beta, dev);
  }
  await mirrorFeedbackPairs(
    ctx,
    project,
    live.filter((p) => p.devFeedbackId !== null),
    betaById,
  );
}

/**
 * One pair's dev status tried onto its beta issue, once per dev status. A move that would take beta
 * backward (`markers.ts:movesBackward`) is never sent: beta keeps its status, the try is recorded,
 * and the report names the held move. `followed` runs where beta moved.
 */
async function mirrorPair(
  ctx: MirrorContext,
  project: MirrorProject,
  pair: Pair,
  beta: PeerIssue,
  dev: MirroredDevIssue,
  followed?: (reached: string) => Promise<void>,
): Promise<void> {
  const owed = owesTry(pair, dev.status, beta.status);
  if (owed === null) return;
  const target = mirrorTarget(dev.status);
  if (target === null || target === beta.status) {
    await recordTry({
      betaIssueId: beta.id,
      tried: dev.status,
      reached: beta.status,
      taken: target !== null,
    });
    return;
  }
  if (movesBackward(beta.status, target)) {
    await recordTry({
      betaIssueId: beta.id,
      tried: dev.status,
      reached: beta.status,
      taken: false,
    });
    ctx.report.held.push(
      `${project.twin.slug}: ${dev.key} at ${dev.status}: beta ${beta.key} keeps ${beta.status}, not moved back to ${target}`,
    );
    return;
  }
  if (ctx.budget.mirrors <= 0) {
    ctx.report.waiting += 1;
    return;
  }
  ctx.budget.mirrors -= 1;
  const tried = await mirrorOne(ctx, project, { pair, beta, dev }, target, owed !== 'try');
  // recorded whatever beta answered, so the same try is never made or commented twice
  await recordTry({
    betaIssueId: beta.id,
    tried: dev.status,
    reached: tried.reached,
    taken: tried.reached === target,
    ...(tried.closeRefused ? { closeRefused: tried.closeRefused } : {}),
  });
  if (followed && tried.reached !== beta.status) await followed(tried.reached);
}

/** The triage outcome a ported item is commented on beta for, moving no status; null for none. */
function toldOf(triage: PortedTriage): FeedbackTold | null {
  if (triage.status === 'declined') return 'declined';
  if (triage.route === 'revision' || triage.route === 'new_requirement') return 'requirement';
  if (triage.route === 'answer') return 'answer';
  if (triage.route === 'duplicate') return 'duplicate';
  return null;
}

/**
 * The pairs ported as Feedback (ISS-982), mirrored from what each item's triage made of it, read
 * from the item's own record. An issue route mirrors once the issues it names have landed, from the
 * least advanced of them, with one log comment naming them; a requirement route, an answer, a
 * decline or a duplicate is commented on beta once, and moves no status.
 */
async function mirrorFeedbackPairs(
  ctx: MirrorContext,
  project: MirrorProject,
  pairs: readonly Pair[],
  betaById: ReadonlyMap<string, PeerIssue>,
): Promise<void> {
  if (pairs.length === 0) return;
  const triages = await triageOutcomesOf(pairs.map((p) => p.devFeedbackId as string));
  const devs = await devIssuesById(
    project.twin,
    [...triages.values()].flatMap((t) => t.issueIds),
  );
  for (const pair of pairs) {
    const beta = betaById.get(pair.betaIssueId) as PeerIssue;
    const triage = triages.get(pair.devFeedbackId as string);
    if (!triage) continue;
    const told = toldOf(triage);
    if (told !== null) {
      if (pair.feedbackTold !== told) await tellOnce(ctx, project, pair, beta, triage, told);
      continue;
    }
    const routed = triage.issueIds
      .map((id) => devs.get(id))
      .filter((d): d is MirroredDevIssue => d !== undefined);
    const lead = routed.reduce<MirroredDevIssue | null>(
      (least, d) => (least === null || progressOf(d.status) < progressOf(least.status) ? d : least),
      null,
    );
    if (lead === null || !hasLanded(lead.status)) continue;
    const keys = routed.map((d) => d.key);
    await mirrorPair(ctx, project, pair, beta, lead, async () => {
      const said = await postPeerComment(
        ctx.peer,
        beta.id,
        feedbackMirroredComment(keys, triage.key, lead.status),
      );
      if (!said.ok) {
        ctx.report.refused.push(
          `${project.twin.slug}: beta ${beta.key} log comment: ${said.refusal.code}`,
        );
      }
    });
  }
}

/** A triage outcome commented on beta once; recorded only once beta took the comment. */
async function tellOnce(
  ctx: MirrorContext,
  project: MirrorProject,
  pair: Pair,
  beta: PeerIssue,
  triage: PortedTriage,
  told: FeedbackTold,
): Promise<void> {
  if (ctx.budget.mirrors <= 0) {
    ctx.report.waiting += 1;
    return;
  }
  ctx.budget.mirrors -= 1;
  const said = await postPeerComment(
    ctx.peer,
    beta.id,
    feedbackToldComment(triage.key, told, triage.answer),
  );
  if (!said.ok) {
    ctx.report.refused.push(
      `${project.twin.slug}: ${triage.key} → beta ${beta.key} ${told} comment: ${said.refusal.code}; tried again next fire`,
    );
    return;
  }
  await recordTold(pair.betaIssueId, told);
  ctx.report.told.push(`${project.twin.slug}: ${triage.key} → beta ${beta.key} (${told})`);
}

/** One pair as a mirror move reads it: its record, its beta issue and its dev issue. */
interface Move {
  pair: Pair;
  beta: PeerIssue;
  dev: MirroredDevIssue;
}

/** One mirror move onto beta; the beta status beta stands at after it, as beta stored it. */
async function mirrorOne(
  ctx: MirrorContext,
  project: MirrorProject,
  move: Move,
  target: string,
  commentedBefore: boolean,
): Promise<Tried> {
  const { twin } = project;
  const { beta, dev } = move;
  const line = (to: string, how = '') =>
    `${twin.slug}: ${dev.key}: ${beta.status} → ${to} (beta ${beta.key})${how}`;
  const moved = await transitionPeerIssue(
    ctx.peer,
    beta.id,
    target,
    mirrorReason(dev.key, dev.status),
  );
  const stored = moved.ok ? (moved.value.stored ?? target) : null;
  if (stored === target) {
    ctx.report.mirrored.push(line(target));
    return { reached: target };
  }
  if (target === 'closed') return closeOnBeta(ctx, project, move, moved, line);
  if (stored !== null) {
    ctx.report.mirrored.push(line(stored, `; beta stored ${stored} where ${target} was asked`));
    return { reached: stored };
  }
  const code = moved.ok ? '' : moved.refusal.code;
  ctx.report.refused.push(`${twin.slug}: ${dev.key} → beta ${beta.key} ${target}: ${code}`);
  if (!commentedBefore) {
    const told = await postPeerComment(
      ctx.peer,
      beta.id,
      mirrorRefusedComment(dev.key, dev.status, code),
    );
    if (!told.ok) {
      ctx.report.refused.push(
        `${twin.slug}: beta ${beta.key} refusal comment: ${told.refusal.code}`,
      );
    }
  }
  return { reached: beta.status };
}

/**
 * A close beta did not take, finished the way beta closes an issue (ISS-1005). Beta's merge mark is
 * sent where beta holds none, in the beta project's landing shape (`sendMark`), and a close refused
 * for want of it is asked again. Where beta still has not closed it, the dev release that closed the
 * twin is recorded on beta (`closeByRelease`), from beta's release gate. Where beta refuses that too,
 * the beta issue stands at the nearest status it took, the refusal is commented there once (the
 * pair's `closeRefused`), and the close stays owed (`markers.ts:owesTry`).
 */
async function closeOnBeta(
  ctx: MirrorContext,
  project: MirrorProject,
  move: Move,
  first: PeerAnswer<{ stored: string | null }>,
  line: (to: string, how?: string) => string,
): Promise<Tried> {
  const { twin } = project;
  const { pair, beta, dev } = move;
  const refused: string[] = [];
  let at = beta.status;
  if (first.ok) {
    at = first.value.stored ?? at;
    refused.push(`closed was stored as ${at}`);
  } else {
    refused.push(first.refusal.code);
  }
  let recorded = '';
  if (beta.marked !== true) {
    const says = await sendMark(ctx, project, beta, dev, refused);
    if (says) recorded = `, ${says}`;
    if (says && !first.ok && first.refusal.code === 'CLOSE_REQUIRES_SHIPPED') {
      const again = await transitionPeerIssue(
        ctx.peer,
        beta.id,
        'closed',
        mirrorReason(dev.key, dev.status),
      );
      const stored = again.ok ? (again.value.stored ?? 'closed') : null;
      if (stored === 'closed') {
        ctx.report.mirrored.push(line('closed', recorded));
        return { reached: 'closed' };
      }
      if (stored !== null) at = stored;
      refused.push(
        `after the landing was recorded: ${again.ok ? `closed was stored as ${stored}` : again.refusal.code}`,
      );
    }
  }
  const released = await closeByRelease(ctx, project, move, at, refused);
  if (released.closed) {
    ctx.report.mirrored.push(
      line(
        'closed',
        `${recorded}, by forge-dev release ${released.release?.version} recorded on beta`,
      ),
    );
    return { reached: 'closed' };
  }
  at = released.at;
  const codes = refused.join(', ');
  ctx.report.refused.push(`${twin.slug}: ${dev.key} → beta ${beta.key} closed: ${codes}`);
  if (at !== beta.status) {
    ctx.report.mirrored.push(
      line(at, `${recorded}; closed refused (${codes}), the nearest status beta takes`),
    );
  }
  if (pair.closeRefused !== null) return { reached: at };
  const told = await postPeerComment(
    ctx.peer,
    beta.id,
    closeRefusedComment(dev.key, released.release, codes),
  );
  if (!told.ok) {
    ctx.report.refused.push(`${twin.slug}: beta ${beta.key} refusal comment: ${told.refusal.code}`);
    return { reached: at };
  }
  return { reached: at, closeRefused: codes };
}

/**
 * The dev release that closed the twin, recorded on beta by the door beta serves for a release
 * already performed (`POST /api/projects/:id/release-records`), which closes the issues it carries
 * from beta's release gate. The beta issue is first moved to that gate (`awaiting_release`), the
 * nearest status a close is taken from, and given the twin's release note where it holds none, both
 * of which beta's record requires. Every refusal met is added to `refused`; `at` is where beta stands.
 */
async function closeByRelease(
  ctx: MirrorContext,
  project: MirrorProject,
  move: Move,
  from: string,
  refused: string[],
): Promise<{ closed: boolean; at: string; release: DevRelease | null }> {
  const { twin } = project;
  const { beta, dev } = move;
  const release = (await project.releases()).find((r) => r.issueIds.includes(dev.id)) ?? null;
  if (!release) {
    refused.push(
      `BETA_PORT_NO_DEV_RELEASE: no forge-dev release of ${twin.slug} carries ${dev.key}, so none was recorded on beta`,
    );
  }
  let at = from;
  if (at !== 'awaiting_release') {
    const nearest = await transitionPeerIssue(
      ctx.peer,
      beta.id,
      'awaiting_release',
      nearestReason(dev.key, refused.join(', ')),
    );
    if (!nearest.ok) {
      refused.push(`awaiting_release: ${nearest.refusal.code}`);
      return { closed: false, at, release };
    }
    at = nearest.value.stored ?? 'awaiting_release';
    if (at !== 'awaiting_release') {
      refused.push(`awaiting_release was stored as ${at}`);
      return { closed: false, at, release };
    }
  }
  if (!release) return { closed: false, at, release };
  if (!release.commit) {
    refused.push(
      `BETA_PORT_NO_RELEASE_COMMIT: forge-dev ${twin.slug} ${release.version} names no commit, and beta's release record names the commit production serves`,
    );
    return { closed: false, at, release };
  }
  if (!(await noteOnBeta(ctx, move, refused))) return { closed: false, at, release };
  const record = await recordPeerRelease(ctx.peer, project.betaProjectId, {
    issueIds: [beta.id],
    commit: release.commit,
    account: releaseRecordAccount(twin.slug, dev.key, release),
    providerRef: releaseRecordRef(twin.slug, release),
  });
  if (!record.ok) {
    refused.push(`recording forge-dev release ${release.version}: ${record.refusal.code}`);
    return { closed: false, at, release };
  }
  if (record.value.closed.includes(beta.id)) return { closed: true, at: 'closed', release };
  const failed = record.value.failed.find((f) => f.id === beta.id);
  refused.push(
    `forge-dev release ${release.version} was recorded on beta, which did not close it: ${failed?.reason ?? 'its record names it neither closed nor failed'}`,
  );
  return { closed: false, at, release };
}

/**
 * Whether the beta issue holds a release note, which beta's release record requires of every issue it
 * closes: read from the issue, and where it holds none, the dev twin's written there. A dev twin with
 * no note is named and nothing is written: a note is never made up.
 */
async function noteOnBeta(ctx: MirrorContext, move: Move, refused: string[]): Promise<boolean> {
  const { beta, dev } = move;
  const held = await readPeerReleaseNoted(ctx.peer, beta.id);
  if (!held.ok) {
    refused.push(`reading its release note: ${held.refusal.code}`);
    return false;
  }
  if (held.value === true) return true;
  const note = betaReleaseNote(dev);
  if (!note) {
    refused.push(
      `BETA_PORT_NO_RELEASE_NOTE: ${dev.key} holds no release note, and beta's release record requires one`,
    );
    return false;
  }
  const wrote = await writePeerReleaseNote(ctx.peer, beta.id, note);
  if (!wrote.ok) {
    refused.push(`writing its release note: ${wrote.refusal.code}`);
    return false;
  }
  return true;
}

/**
 * Beta's merge mark for a dev issue, sent in its project's landing shape; how the report words it, or
 * null where none was sent: the dev issue holds no commit a git twin's mark names, the beta project's
 * shape cannot be read, or beta refused it, each added to `refused`.
 */
async function sendMark(
  ctx: MirrorContext,
  project: MirrorProject,
  beta: PeerIssue,
  dev: MirroredDevIssue,
  refused: string[],
): Promise<string | null> {
  const landing = await project.landing();
  if (!landing.ok) {
    const named = `${project.twin.slug}: beta landing shape: ${landing.refusal.code} (${landing.refusal.detail})`;
    if (!ctx.report.refused.includes(named)) ctx.report.refused.push(named);
    refused.push(`the beta project's landing shape: ${landing.refusal.code}`);
    return null;
  }
  const built = landingMark(dev, landing.value);
  if (!built.ok) {
    refused.push(built.refusal);
    return null;
  }
  const mark = await markPeerIssueLanded(ctx.peer, beta.id, built.mark);
  if (!mark.ok) {
    refused.push(`recording the landing: ${mark.refusal.code}`);
    return null;
  }
  return built.says;
}
