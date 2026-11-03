// The mirror half of a beta port fire (ISS-923): each ported pair's dev status, tried onto its beta
// issue once. A move beta takes is reported; a close beta refuses for want of a shipped record is
// finished the nearest legal way (`finishClose`), its merge mark in the beta project's landing shape;
// a move beta refuses outright is commented there once. Each try is recorded on the pair with the
// status beta stood at after it, so nothing repeats and nothing claims a status beta never took.

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
  landingMark,
  mirrorReason,
  mirrorRefusedComment,
  mirrorTarget,
  nearestReason,
  owesTry,
} from './markers.js';
import type { BetaPortReport } from './report.js';
import {
  type DevTwin,
  devIssuesById,
  type MirroredDevIssue,
  type Pair,
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
  const devs = await devIssuesById(
    twin,
    live.map((p) => p.devIssueId),
  );
  for (const pair of live) {
    const beta = betaById.get(pair.betaIssueId) as PeerIssue;
    const dev = devs.get(pair.devIssueId);
    if (!dev) continue;
    const owed = owesTry(pair, dev.status, beta.status);
    if (owed === null) continue;
    const target = mirrorTarget(dev.status);
    if (target === null || target === beta.status) {
      await recordTry({
        betaIssueId: beta.id,
        tried: dev.status,
        reached: beta.status,
        taken: target !== null,
      });
      continue;
    }
    if (ctx.budget.mirrors <= 0) {
      ctx.report.waiting += 1;
      continue;
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
  }
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
