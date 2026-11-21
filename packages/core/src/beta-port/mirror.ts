// The mirror half of a beta port fire (ISS-923): each ported pair's dev status, tried onto its beta
// issue once, and never backward (ISS-982: `markers.ts:BETA_PORT_PROGRESS` is the order). A pair
// ported as Feedback follows the issues its triage routed to once they land, or is told its outcome.
// A move beta takes is reported, at the status beta stored; a move beta refuses outright is commented
// there once. A close is beta's by a release (ISS-1005): where beta refuses a plain close, its merge
// mark is sent in the beta project's landing shape, and the dev release that closed the twin is
// recorded on beta, which closes it (`mirror-close.ts:closeOnBeta`); where beta refuses that too, the beta issue
// stands at the nearest status it takes, the refusal is commented there once, and the close is tried
// again at every fire until beta takes it. Each try is recorded on the pair with the status beta
// stood at after it, so nothing claims a status beta never took.

import {
  type PeerAnswer,
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
  mirrorReason,
  mirrorRefusedComment,
  mirrorTarget,
  movesBackward,
  owesTry,
  passedOverWhy,
  progressOf,
} from './markers.js';
import {
  closeOnBeta,
  type MirrorContext,
  type MirrorProject,
  type Move,
  type Tried,
} from './mirror-close.js';
import { type PortedTriage, triageOutcomesOf } from './ports.js';
import type { BetaPortReport } from './report.js';
import {
  type DevTwin,
  devIssuesById,
  devReleaseOf,
  type MirroredDevIssue,
  type Pair,
  recordTold,
  recordTry,
} from './store.js';

export type { MirrorContext } from './mirror-close.js';

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
    betaProjectId: where.betaProjectId,
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
  const owingNothing: string[] = [];
  const account = async (pair: Pair, beta: PeerIssue, work: () => Promise<void>) => {
    const before = linesOf(ctx.report);
    await work();
    if (linesOf(ctx.report) === before) owingNothing.push(`beta ${pair.betaKey} at ${beta.status}`);
  };
  for (const pair of twins) {
    const beta = betaById.get(pair.betaIssueId) as PeerIssue;
    const dev = devs.get(pair.devIssueId as string);
    await account(pair, beta, async () => {
      if (dev) await mirrorPair(ctx, project, pair, beta, dev);
      else {
        ctx.report.refused.push(
          `${twin.slug}: beta ${pair.betaKey}: BETA_PORT_TWIN_GONE: its pair names a dev issue ${twin.slug} no longer holds, so nothing is mirrored`,
        );
      }
    });
  }
  await mirrorFeedbackPairs(
    ctx,
    project,
    live.filter((p) => p.devFeedbackId !== null),
    betaById,
    account,
  );
  if (owingNothing.length > 0) {
    ctx.report.inStep.push(`${twin.slug}: ${owingNothing.length} (${owingNothing.join(', ')})`);
  }
}

/** Every line a pair's mirror can leave, counted: a pair that left none owed nothing. */
const linesOf = (r: BetaPortReport) =>
  r.mirrored.length + r.held.length + r.refused.length + r.told.length + r.waiting;

type Account = (pair: Pair, beta: PeerIssue, work: () => Promise<void>) => Promise<void>;

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
  if (owed === null) {
    // a dev twin ahead of its beta row is named with why it is owed no try, never passed over
    const why = passedOverWhy(pair, dev.status, beta.status);
    if (why) {
      ctx.report.held.push(
        `${project.twin.slug}: ${dev.key} at ${dev.status}: beta ${beta.key} stands at ${beta.status}; ${why}`,
      );
    }
    return;
  }
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
  account: Account,
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
    await account(pair, beta, async () => {
      if (!triage) {
        ctx.report.refused.push(
          `${project.twin.slug}: beta ${pair.betaKey}: BETA_PORT_TWIN_GONE: its pair names a Feedback item ${project.twin.slug} no longer holds, so nothing is mirrored`,
        );
        return;
      }
      await mirrorFeedbackPair(ctx, project, { pair, beta, triage, devs });
    });
  }
}

/** One Feedback pair, mirrored from its triage: told once, or following the issue it routed to. */
async function mirrorFeedbackPair(
  ctx: MirrorContext,
  project: MirrorProject,
  at: {
    pair: Pair;
    beta: PeerIssue;
    triage: PortedTriage;
    devs: ReadonlyMap<string, MirroredDevIssue>;
  },
): Promise<void> {
  const { pair, beta, triage, devs } = at;
  const told = toldOf(triage);
  if (told !== null) {
    if (pair.feedbackTold !== told) await tellOnce(ctx, project, pair, beta, triage, told);
    return;
  }
  const routed = triage.issueIds
    .map((id) => devs.get(id))
    .filter((d): d is MirroredDevIssue => d !== undefined);
  const lead = routed.reduce<MirroredDevIssue | null>(
    (least, d) => (least === null || progressOf(d.status) < progressOf(least.status) ? d : least),
    null,
  );
  if (lead === null || !hasLanded(lead.status)) return;
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
  // a close names the dev release that shipped the twin, on beta and in the report (ISS-1387)
  const release = target === 'closed' ? await devReleaseOf(twin, dev.id) : null;
  const shipped = release ? `, shipped in forge-dev release ${release.version}` : '';
  const line = (to: string, how = '') =>
    `${twin.slug}: ${dev.key}: ${beta.status} → ${to} (beta ${beta.key})${how}`;
  const moved = await transitionPeerIssue(
    ctx.peer,
    beta.id,
    target,
    mirrorReason(dev.key, dev.status, release?.version),
  );
  const stored = moved.ok ? (moved.value.stored ?? target) : null;
  if (stored === target) {
    ctx.report.mirrored.push(line(target, shipped));
    return { reached: target };
  }
  if (target === 'closed') return closeOnBeta(ctx, project, { ...move, release }, moved, line);
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
