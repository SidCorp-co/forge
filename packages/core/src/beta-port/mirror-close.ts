// The close half of a beta port mirror (ISS-1005): a close beta did not take, finished the way beta
// closes an issue, by a merge mark in the beta project's landing shape and then the dev release that
// closed the twin, recorded on beta from its release gate. Split from `mirror.ts`, which owns the
// order of moves; this file owns only what a close sends and what beta answered.

import {
  markPeerIssueLanded,
  type PeerAnswer,
  type PeerForge,
  type PeerIssue,
  type PeerLanding,
  postPeerComment,
  readPeerReleaseNoted,
  recordPeerRelease,
  transitionPeerIssue,
  writePeerReleaseNote,
} from '../integrations/peer-forge/index.js';
import {
  betaReleaseNote,
  closeRefusedComment,
  landingMark,
  mirrorReason,
  nearestReason,
  releaseRecordAccount,
  releaseRecordRef,
} from './markers.js';
import type { BetaPortReport } from './report.js';
import type { DevRelease, DevTwin, MirroredDevIssue, Pair } from './store.js';

/** What the mirror half of a fire reads and writes: beta, the report, and the fire's mirror bound. */
export interface MirrorContext {
  peer: PeerForge;
  report: BetaPortReport;
  budget: { mirrors: number };
}

/** One beta project and its dev twin, with its landing shape read at most once per fire. */
export interface MirrorProject {
  twin: DevTwin;
  betaProjectId: string;
  landing: () => Promise<PeerAnswer<PeerLanding>>;
}

/** One try's outcome: the beta status after it, and the close refusal it commented on beta. */
export interface Tried {
  reached: string;
  closeRefused?: string;
}

/** One pair as a mirror move reads it: its record, its beta issue and its dev issue. */
export interface Move {
  pair: Pair;
  beta: PeerIssue;
  dev: MirroredDevIssue;
}

/** A close: the move, with the dev release that shipped the twin, null where none carries it. */
export type Closing = Move & { release: DevRelease | null };

/**
 * A close beta did not take, finished the way beta closes an issue (ISS-1005). Beta's merge mark is
 * sent where beta holds none, in the beta project's landing shape (`sendMark`), and a close refused
 * for want of it is asked again. Where beta still has not closed it, the dev release that closed the
 * twin is recorded on beta (`closeByRelease`), from beta's release gate. Where beta refuses that too,
 * the beta issue stands at the nearest status it took, the refusal is commented there once (the
 * pair's `closeRefused`), and the close stays owed (`markers.ts:owesTry`).
 */
export async function closeOnBeta(
  ctx: MirrorContext,
  project: MirrorProject,
  move: Closing,
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
        mirrorReason(dev.key, dev.status, move.release?.version),
      );
      const stored = again.ok ? (again.value.stored ?? 'closed') : null;
      if (stored === 'closed') {
        const shipped = move.release
          ? `, shipped in forge-dev release ${move.release.version}`
          : '';
        ctx.report.mirrored.push(line('closed', `${recorded}${shipped}`));
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
  move: Closing,
  from: string,
  refused: string[],
): Promise<{ closed: boolean; at: string; release: DevRelease | null }> {
  const { twin } = project;
  const { beta, dev, release } = move;
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
