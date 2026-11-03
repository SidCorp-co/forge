// The mirror half of a beta port fire (ISS-923): each ported pair's dev status, tried onto its beta
// issue once. A move beta takes is reported; a close beta refuses for want of a shipped record is
// finished the nearest legal way (`finishClose`); a move beta refuses outright is commented there
// once. Each try is recorded on the pair with the status beta stood at after it, so nothing repeats
// and nothing claims a status beta never took.

import {
  markPeerIssueLanded,
  type PeerForge,
  type PeerIssue,
  postPeerComment,
  transitionPeerIssue,
} from '../integrations/peer-forge/index.js';
import {
  devLanding,
  landedNote,
  mirrorReason,
  mirrorRefusedComment,
  mirrorTarget,
  nearestReason,
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

/**
 * Whether a pair owes beta a try of the dev status. A pair tried under this rule is tried once per dev
 * status. One tried under the old rule (no `lastTriedStatus`) recorded the dev status as mirrored
 * whether beta took it or not; where beta does not stand at that status's target, beta refused it,
 * and it is tried once more under this rule.
 */
export function owesTry(
  pair: Pick<Pair, 'lastMirroredStatus' | 'lastTriedStatus'>,
  devStatus: string,
  betaStatus: string,
): 'try' | 'retry-old' | null {
  if (pair.lastTriedStatus !== null) return devStatus === pair.lastTriedStatus ? null : 'try';
  if (devStatus !== pair.lastMirroredStatus) return 'try';
  const target = mirrorTarget(devStatus);
  return target !== null && target !== betaStatus ? 'retry-old' : null;
}

export async function mirrorProject(
  ctx: MirrorContext,
  twin: DevTwin,
  betaIssues: readonly PeerIssue[],
  pairs: ReadonlyMap<string, Pair>,
): Promise<void> {
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
    const reached = await mirrorOne(ctx, twin, beta, dev, target, owed === 'retry-old');
    // recorded whatever beta answered, so the same try is never made or commented twice
    await recordTry({
      betaIssueId: beta.id,
      tried: dev.status,
      reached,
      taken: reached === target,
    });
  }
}

/** One mirror move onto beta; the beta status beta stands at after it. */
async function mirrorOne(
  ctx: MirrorContext,
  twin: DevTwin,
  beta: PeerIssue,
  dev: MirroredDevIssue,
  target: string,
  commentedBefore: boolean,
): Promise<string> {
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
    return target;
  }
  const refused = [moved.refusal.code];
  if (target === 'closed') {
    const finished = await finishClose(ctx, beta, dev, moved.refusal.code, refused);
    if (finished) {
      ctx.report.mirrored.push(line(finished.reached, finished.how));
      return finished.reached;
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
  return beta.status;
}

/**
 * A close beta refused, finished the nearest legal way: where it was refused for want of a shipped
 * record, beta's merge mark records where the work landed (the dev key and the dev issue's landing)
 * and the close is tried again; where beta still refuses it, beta moves to `awaiting_release`, the
 * status a close is taken from. Null where beta took neither; every refusal met is added to `refused`.
 */
async function finishClose(
  ctx: MirrorContext,
  beta: PeerIssue,
  dev: MirroredDevIssue,
  code: string,
  refused: string[],
): Promise<{ reached: string; how: string } | null> {
  let marked = false;
  if (code === 'CLOSE_REQUIRES_SHIPPED') {
    const mark = await markPeerIssueLanded(ctx.peer, beta.id, devLanding(dev), landedNote(dev.key));
    if (mark.ok) {
      marked = true;
      const closed = await transitionPeerIssue(
        ctx.peer,
        beta.id,
        'closed',
        mirrorReason(dev.key, dev.status),
      );
      if (closed.ok)
        return { reached: 'closed', how: `, its landing recorded as ${devLanding(dev)}` };
      refused.push(`after the landing was recorded: ${closed.refusal.code}`);
    } else {
      refused.push(`recording the landing: ${mark.refusal.code}`);
    }
  }
  if (beta.status === 'awaiting_release') return null;
  const nearest = await transitionPeerIssue(
    ctx.peer,
    beta.id,
    'awaiting_release',
    nearestReason(dev.key, refused.join(', ')),
  );
  if (nearest.ok) {
    const landed = marked ? `, its landing recorded as ${devLanding(dev)}` : '';
    return {
      reached: 'awaiting_release',
      how: `${landed}; closed refused (${refused.join(', ')}), the nearest status beta takes`,
    };
  }
  refused.push(`awaiting_release: ${nearest.refusal.code}`);
  return null;
}
