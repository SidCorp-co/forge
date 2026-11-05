// The mirror half of a beta port fire (ISS-923): each ported pair's dev status, tried onto its beta
// issue once, and never backward (ISS-982: `markers.ts:BETA_PORT_PROGRESS` is the order). A pair
// ported as Feedback follows the issues its triage routed to once they land, or is told its outcome.
// A move beta takes is reported; a close beta refuses for want of a shipped record is finished the
// nearest legal way (`finishClose`), its merge mark in the beta project's landing shape; a move beta
// refuses outright is commented there once. Each try is recorded on the pair with the status beta
// stood at after it, so nothing repeats and nothing claims a status beta never took.

import {
  markPeerIssueLanded,
  type PeerAnswer,
  type PeerForge,
  type PeerIssue,
  type PeerLanding,
  postPeerComment,
  readPeerLanding,
  transitionPeerIssue,
} from '../integrations/peer-forge/index.js';
import {
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
} from './markers.js';
import { type PortedTriage, triageOutcomesOf } from './ports.js';
import type { BetaPortReport } from './report.js';
import {
  type DevTwin,
  devIssuesById,
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

/** One beta project and its dev twin, with its landing shape read at most once per fire. */
interface MirrorProject {
  twin: DevTwin;
  landing: () => Promise<PeerAnswer<PeerLanding>>;
}

/** One try's outcome: the beta status after it, and whether its close's mark question was settled. */
interface Tried {
  reached: string;
  shapeSettled: boolean;
}

export async function mirrorProject(
  ctx: MirrorContext,
  where: { betaProjectId: string; twin: DevTwin },
  betaIssues: readonly PeerIssue[],
  pairs: ReadonlyMap<string, Pair>,
): Promise<void> {
  const { twin } = where;
  let landing: Promise<PeerAnswer<PeerLanding>> | null = null;
  const project: MirrorProject = {
    twin,
    landing: () => {
      landing ??= readPeerLanding(ctx.peer, where.betaProjectId);
      return landing;
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
  const tried = await mirrorOne(ctx, project, beta, dev, target, owed !== 'try');
  // recorded whatever beta answered, so the same try is never made or commented twice
  await recordTry({
    betaIssueId: beta.id,
    tried: dev.status,
    reached: tried.reached,
    taken: tried.reached === target,
    shapeSettled: target === 'closed' && tried.shapeSettled,
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

/** One mirror move onto beta; the beta status beta stands at after it. */
async function mirrorOne(
  ctx: MirrorContext,
  project: MirrorProject,
  beta: PeerIssue,
  dev: MirroredDevIssue,
  target: string,
  commentedBefore: boolean,
): Promise<Tried> {
  const { twin } = project;
  const line = (to: string, how = '') =>
    `${twin.slug}: ${dev.key}: ${beta.status} → ${to} (beta ${beta.key})${how}`;
  const moved = await transitionPeerIssue(
    ctx.peer,
    beta.id,
    target,
    mirrorReason(dev.key, dev.status),
  );
  if (moved.ok) {
    ctx.report.mirrored.push(line(target));
    return { reached: target, shapeSettled: true };
  }
  const refused = [moved.refusal.code];
  let shapeSettled = true;
  if (target === 'closed') {
    const finished = await finishClose(ctx, project, beta, dev, moved.refusal.code, refused);
    shapeSettled = finished.shapeSettled;
    if (finished.reached) {
      ctx.report.mirrored.push(line(finished.reached, finished.how));
      return { reached: finished.reached, shapeSettled };
    }
  }
  const codes = refused.join(', ');
  ctx.report.refused.push(`${twin.slug}: ${dev.key} → beta ${beta.key} ${target}: ${codes}`);
  if (!commentedBefore) {
    const told = await postPeerComment(
      ctx.peer,
      beta.id,
      mirrorRefusedComment(dev.key, dev.status, codes),
    );
    if (!told.ok) {
      ctx.report.refused.push(
        `${twin.slug}: beta ${beta.key} refusal comment: ${told.refusal.code}`,
      );
    }
  }
  return { reached: beta.status, shapeSettled };
}

/**
 * A close beta refused, finished the nearest legal way: where it was refused for want of a shipped
 * record, beta's merge mark records where the work landed, in the shape the beta project's landing
 * takes (`landingMark`), and the close is tried again; where beta still refuses it, beta moves to
 * `awaiting_release`, the status a close is taken from. No mark is sent where beta already holds one,
 * where the dev issue holds no commit a git twin's mark names, or where the beta project's shape
 * cannot be read; the last leaves the close owed (`shapeSettled` false), so the next fire tries it
 * again. `reached` is null where beta took neither move; every refusal met is added to `refused`.
 */
async function finishClose(
  ctx: MirrorContext,
  project: MirrorProject,
  beta: PeerIssue,
  dev: MirroredDevIssue,
  code: string,
  refused: string[],
): Promise<{ reached: string | null; how: string; shapeSettled: boolean }> {
  let recorded = '';
  let shapeSettled = true;
  if (code === 'CLOSE_REQUIRES_SHIPPED' && beta.marked === true) {
    refused.push('beta already holds a merge mark on it, so no second one was sent');
  } else if (code === 'CLOSE_REQUIRES_SHIPPED') {
    const sent = await sendMark(ctx, project, beta, dev, refused);
    shapeSettled = sent.shapeSettled;
    if (sent.says) {
      recorded = `, ${sent.says}`;
      const closed = await transitionPeerIssue(
        ctx.peer,
        beta.id,
        'closed',
        mirrorReason(dev.key, dev.status),
      );
      if (closed.ok) return { reached: 'closed', how: recorded, shapeSettled };
      refused.push(`after the landing was recorded: ${closed.refusal.code}`);
    }
  }
  if (beta.status === 'awaiting_release') return { reached: null, how: '', shapeSettled };
  const nearest = await transitionPeerIssue(
    ctx.peer,
    beta.id,
    'awaiting_release',
    nearestReason(dev.key, refused.join(', ')),
  );
  if (nearest.ok) {
    return {
      reached: 'awaiting_release',
      how: `${recorded}; closed refused (${refused.join(', ')}), the nearest status beta takes`,
      shapeSettled,
    };
  }
  refused.push(`awaiting_release: ${nearest.refusal.code}`);
  return { reached: null, how: '', shapeSettled };
}

/** Beta's merge mark for a dev issue, sent in its project's landing shape; how the report words it. */
async function sendMark(
  ctx: MirrorContext,
  project: MirrorProject,
  beta: PeerIssue,
  dev: MirroredDevIssue,
  refused: string[],
): Promise<{ says: string | null; shapeSettled: boolean }> {
  const landing = await project.landing();
  if (!landing.ok) {
    const named = `${project.twin.slug}: beta landing shape: ${landing.refusal.code} (${landing.refusal.detail})`;
    if (!ctx.report.refused.includes(named)) ctx.report.refused.push(named);
    refused.push(`the beta project's landing shape: ${landing.refusal.code}`);
    return { says: null, shapeSettled: false };
  }
  const built = landingMark(dev, landing.value);
  if (!built.ok) {
    refused.push(built.refusal);
    return { says: null, shapeSettled: true };
  }
  const mark = await markPeerIssueLanded(ctx.peer, beta.id, built.mark);
  if (!mark.ok) {
    refused.push(`recording the landing: ${mark.refusal.code}`);
    return { says: null, shapeSettled: true };
  }
  return { says: built.says, shapeSettled: true };
}
