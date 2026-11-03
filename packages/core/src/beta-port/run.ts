// One `beta_port` fire (ISS-923, owner ruling 2026-11-03 `beta-issues-are-worked-on-dev`): every
// forge-beta issue filed or reopened after that ruling and not yet ported becomes an open issue in the
// same-slug project here, and every ported pair's dev status is mirrored back onto beta once. Core
// runs it itself: no box, no session. Before it ports, a pair ported with only its provenance line
// gets beta's body under that line, once (`backfill.ts`). It starts in two halves: what is read here (the secrets, the
// ruling's time) is checked before the fire is answered, and the beta reads and writes run after.
// forge-beta's address and token are read from the schedule project's secrets and nowhere else, and
// the token is scrubbed out of everything the fire reports or logs.

import { secretRefOf } from '@forge/contracts/project-config';
import {
  BETA_PORT_SECRET_NAMES,
  BETA_PORT_SECRET_SCOPE,
  type BetaPortFireRefusal,
} from '@forge/contracts/schedules';
import { scrubLogText } from '@forge/observability';
import { issuePriorities } from '../db/schema.js';
import {
  listPeerCommentBodies,
  listPeerIssues,
  listPeerProjects,
  type PeerForge,
  type PeerIssue,
  peerMovedIntoSince,
  postPeerComment,
  readPeerIssueDescription,
} from '../integrations/peer-forge/index.js';
import { createIssue, issueIdOfKey } from '../issues/index.js';
import { formatIssueRef } from '../lib/issue-ref.js';
import { logger } from '../lib/logger.js';
import { isRefusal } from '../lib/refusal.js';
import { readProjectSecrets } from '../project-config/index.js';
import { backfillBodies } from './backfill.js';
import {
  firstLineNamesBetaIssue,
  isPortedMarker,
  markerDevKey,
  portedComment,
  portedDescription,
  UNPORTED_BETA_STATUSES,
} from './markers.js';
import { mirrorProject } from './mirror.js';
import { type BetaPortReport, emptyReport, renderReport, reportSaysSomething } from './report.js';
import {
  type DevIssue,
  type DevTwin,
  devFirstLines,
  devTwinsBySlug,
  type Pair,
  pairsOf,
  RULING_SLUG,
  recordPair,
  rulingCutoff,
} from './store.js';

/** At most this many beta issues are ported by one fire; the rest are the next fire's. */
export const MAX_PORTS_PER_FIRE = 25;
/** At most this many mirror moves are tried by one fire; the rest are the next fire's. */
export const MAX_MIRRORS_PER_FIRE = 50;

export const BETA_URL_REF = secretRefOf(BETA_PORT_SECRET_SCOPE, BETA_PORT_SECRET_NAMES.url);
export const BETA_TOKEN_REF = secretRefOf(BETA_PORT_SECRET_SCOPE, BETA_PORT_SECRET_NAMES.token);

type Refused = { kind: 'refused'; code: BetaPortFireRefusal; detail: string };

export type BetaPortOutcome =
  | Refused
  | { kind: 'ran'; changed: boolean; output: string; report: BetaPortReport }
  /** The run threw; `error` is scrubbed of the token. */
  | { kind: 'failed'; error: string };

/** A fire checked and ready to run, or refused before anything was read from beta. */
export type BetaPortStart = Refused | { kind: 'ready'; run: () => Promise<BetaPortOutcome> };

interface Budget {
  ports: number;
  mirrors: number;
}

interface FireContext {
  peer: PeerForge;
  fireId: string;
  cutoff: Date;
  report: BetaPortReport;
  budget: Budget;
}

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * The half of a fire core checks before it answers: the secrets, and the ruling's time, which is the
 * cutoff (no date is written here; the entry is read from the org's knowledge at every fire).
 */
export async function startBetaPort(args: {
  projectId: string;
  fireId: string;
}): Promise<BetaPortStart> {
  const secrets = await readProjectSecrets(args.projectId, [BETA_URL_REF, BETA_TOKEN_REF]);
  if (!secrets.ok) {
    return {
      kind: 'refused',
      code: 'BETA_PORT_SECRET_MISSING',
      detail: `${secrets.refs.join(' and ')} ${secrets.code === 'SECRET_VALUE_MISSING' ? 'is not set' : 'does not decrypt under this core'} on this project: PUT /api/projects/${args.projectId}/secrets/${BETA_PORT_SECRET_SCOPE}/<name> for each. Nothing was read from forge-beta and nothing was created.`,
    };
  }
  const cutoff = await rulingCutoff(args.projectId);
  if (!cutoff) {
    return {
      kind: 'refused',
      code: 'BETA_PORT_CUTOFF_MISSING',
      detail: `the org of this project holds no knowledge entry ${RULING_SLUG}, whose creation is the owner's ruling and the time before which no beta issue is ported: nothing was read from forge-beta and nothing was created.`,
    };
  }
  const token = secrets.values.get(BETA_TOKEN_REF) as string;
  const peer: PeerForge = { baseUrl: secrets.values.get(BETA_URL_REF) as string, token };
  const run = async (): Promise<BetaPortOutcome> => {
    try {
      return await runBetaPort({ peer, fireId: args.fireId, cutoff });
    } catch (err) {
      return { kind: 'failed', error: scrubLogText(errText(err), [token]) };
    }
  };
  return { kind: 'ready', run };
}

async function runBetaPort(args: {
  peer: PeerForge;
  fireId: string;
  cutoff: Date;
}): Promise<BetaPortOutcome> {
  const { peer, cutoff } = args;
  const scrub = (text: string) => scrubLogText(text, [peer.token]);

  const listed = await listPeerProjects(peer);
  if (!listed.ok) {
    return {
      kind: 'refused',
      code: 'BETA_PORT_BETA_UNREADABLE',
      detail: scrub(
        `forge-beta's project list was refused ${listed.refusal.code}: ${listed.refusal.detail}. Nothing was created.`,
      ),
    };
  }

  const ctx: FireContext = {
    peer,
    fireId: args.fireId,
    cutoff,
    report: emptyReport(cutoff),
    budget: { ports: MAX_PORTS_PER_FIRE, mirrors: MAX_MIRRORS_PER_FIRE },
  };
  // the bodies the first fire never read come before any new port (ISS-923 backfill)
  await backfillBodies(ctx);
  const betaProjects = [...listed.value].sort((a, b) => a.slug.localeCompare(b.slug));
  const twins = await devTwinsBySlug(betaProjects.map((p) => p.slug));
  for (const project of betaProjects) {
    const twin = twins.get(project.slug);
    if (!twin) {
      ctx.report.noTwin.push(project.slug);
      continue;
    }
    // one project failing does not stop the others: it is reported by name and the fire goes on
    try {
      await portProject(ctx, project.id, twin);
    } catch (err) {
      logger.warn(
        { fireId: args.fireId, slug: project.slug, err: scrub(errText(err)) },
        'beta-port: a project failed',
      );
      ctx.report.refused.push(`${project.slug}: BETA_PORT_PROJECT_FAILED (${errText(err)})`);
    }
  }
  const report = scrubReport(ctx.report, scrub);
  return {
    kind: 'ran',
    changed: reportSaysSomething(report),
    output: renderReport(report),
    report,
  };
}

function scrubReport(report: BetaPortReport, scrub: (t: string) => string): BetaPortReport {
  return {
    cutoff: report.cutoff,
    ported: report.ported.map(scrub),
    mirrored: report.mirrored.map(scrub),
    refused: report.refused.map(scrub),
    skipped: report.skipped.map(scrub),
    noTwin: report.noTwin.map(scrub),
    beforeRuling: report.beforeRuling.map(scrub),
    waiting: report.waiting,
    backfilled: report.backfilled.map(scrub),
    backfillEmpty: report.backfillEmpty.map(scrub),
    backfillOwed: report.backfillOwed.map(scrub),
  };
}

async function portProject(ctx: FireContext, betaProjectId: string, twin: DevTwin): Promise<void> {
  const listed = await listPeerIssues(ctx.peer, betaProjectId);
  if (!listed.ok) {
    ctx.report.refused.push(
      `${twin.slug} issues: ${listed.refusal.code} (${listed.refusal.detail})`,
    );
    return;
  }
  const betaIssues = listed.value;
  const pairs = await pairsOf(betaIssues.map((i) => i.id));
  const named = await devFirstLines(twin);

  let before = 0;
  let noReopenCount = 0;
  for (const beta of betaIssues) {
    if (pairs.has(beta.id) || UNPORTED_BETA_STATUSES.has(beta.status)) continue;
    const after = await afterRuling(ctx, beta, twin);
    if (after === 'unknown') continue;
    if (after !== true) {
      before += 1;
      if (after === 'no-reopen-count') noReopenCount += 1;
      continue;
    }
    const pair = await knownPort(ctx, beta, twin, named);
    if (pair === 'unknown') continue;
    if (pair) {
      pairs.set(beta.id, pair);
      continue;
    }
    if (ctx.budget.ports <= 0) {
      ctx.report.waiting += 1;
      continue;
    }
    ctx.budget.ports -= 1;
    await portOne(ctx, beta, twin);
  }
  if (before > 0) {
    const unread =
      noReopenCount > 0
        ? `; ${noReopenCount} of them carry no reopenCount on beta, so a reopen since cannot be told`
        : '';
    ctx.report.beforeRuling.push(`${twin.slug}: ${before} (not ported${unread})`);
  }

  await mirrorProject(ctx, { betaProjectId, twin }, betaIssues, pairs);
}

/**
 * Whether a beta issue is the ruling's to port: filed after it, or filed before it and moved into
 * `reopen` after it. A reopen is told by the row's `reopenCount` (a move into `reopen` counts one)
 * and then the issue's activity, read only for an old issue that was ever reopened; where beta's row
 * carries no count it cannot be told, and the issue is left with the old ones and said so.
 */
async function afterRuling(
  ctx: FireContext,
  beta: PeerIssue,
  twin: DevTwin,
): Promise<true | false | 'no-reopen-count' | 'unknown'> {
  if (beta.createdAt > ctx.cutoff) return true;
  if (beta.reopenCount === null) return 'no-reopen-count';
  if (beta.reopenCount === 0) return false;
  const reopened = await peerMovedIntoSince(ctx.peer, beta.id, 'reopen', ctx.cutoff);
  if (!reopened.ok) {
    ctx.report.refused.push(
      `${twin.slug}: beta ${beta.key} activity: ${reopened.refusal.code} (${reopened.refusal.detail}); whether it was reopened since the ruling is unread, not ported this fire`,
    );
    return 'unknown';
  }
  return reopened.value !== null;
}

/**
 * Whether a beta issue is already ported, by the dev issue whose first line names it or by a
 * "Ported to forge-dev" comment on it: the pair it is adopted as where the dev issue is found, null
 * where it is not ported, and `unknown` where its comments could not be read (never ported blind).
 */
async function knownPort(
  ctx: FireContext,
  beta: PeerIssue,
  twin: DevTwin,
  named: readonly (DevIssue & { firstLine: string })[],
): Promise<Pair | null | 'unknown'> {
  const dev = named.find((d) => firstLineNamesBetaIssue(d.firstLine, beta));
  if (dev) {
    ctx.report.skipped.push(`${beta.key} (named on ${dev.key})`);
    return adopt(beta, twin, dev.id);
  }
  const comments = await listPeerCommentBodies(ctx.peer, beta.id);
  if (!comments.ok) {
    ctx.report.refused.push(
      `${beta.key} comments: ${comments.refusal.code} (${comments.refusal.detail}); not ported this fire`,
    );
    return 'unknown';
  }
  const marker = comments.value.find(isPortedMarker);
  if (marker === undefined) return null;
  const devKey = markerDevKey(marker);
  const devId = devKey ? await issueIdOfKey(devKey, twin.id) : null;
  ctx.report.skipped.push(
    `${beta.key} (marked ported${devKey ? ` to ${devKey}` : ''}${devKey && !devId ? `, which names no issue in ${twin.slug}: not mirrored` : ''})`,
  );
  return devId ? adopt(beta, twin, devId) : 'unknown';
}

/** A port made before this sweep, recorded with no mirror yet: its first mirror reads beta's status. */
async function adopt(beta: PeerIssue, twin: DevTwin, devIssueId: string): Promise<Pair> {
  const pair: Pair = {
    betaIssueId: beta.id,
    betaKey: beta.key,
    devIssueId,
    lastMirroredStatus: null,
    lastTriedStatus: null,
    betaReached: null,
    closeShapeTriedAt: null,
  };
  await recordPair({ ...pair, betaProjectSlug: twin.slug });
  return pair;
}

const DEV_PRIORITIES: ReadonlySet<string> = new Set(issuePriorities);

async function portOne(ctx: FireContext, beta: PeerIssue, twin: DevTwin): Promise<void> {
  const priority = beta.priority && DEV_PRIORITIES.has(beta.priority) ? beta.priority : undefined;
  let description = beta.description;
  if (description === undefined) {
    // a list projection carries no description: the body is read from the issue itself
    const read = await readPeerIssueDescription(ctx.peer, beta.id);
    if (!read.ok) {
      ctx.report.refused.push(
        `${twin.slug}: beta ${beta.key} body: ${read.refusal.code} (${read.refusal.detail}); not ported this fire`,
      );
      return;
    }
    description = read.value;
  }
  let created: Awaited<ReturnType<typeof createIssue>>;
  try {
    created = await createIssue(
      {
        projectId: twin.id,
        title: beta.title,
        description: portedDescription(beta.key, beta.id, description),
        ...(priority ? { priority } : {}),
        category: beta.category,
        status: 'open',
      },
      {
        // the twin's owner is whose project it is filed in; the writer is this schedule's fire,
        // named on the row (`schedule_run_id`) and on the channel, never a person's hand
        createdById: twin.createdBy,
        createdByDeviceId: null,
        createdVia: 'schedule',
        actor: { type: 'user', id: twin.createdBy, agency: 'agent' },
        scheduleRunId: ctx.fireId,
      },
    );
  } catch (err) {
    const code = isRefusal(err)
      ? (err.refusals[0]?.code ?? err.fallbackCode)
      : 'BETA_PORT_CREATE_FAILED';
    ctx.report.refused.push(`${twin.slug}: beta ${beta.key} → ${code} (${errText(err)})`);
    return;
  }
  if (created.deduped) return;
  const issue = created.issue;
  const devKey = formatIssueRef(twin.prefix, issue.issSeq);
  await recordPair({
    betaIssueId: beta.id,
    betaKey: beta.key,
    devIssueId: issue.id,
    lastMirroredStatus: issue.status,
    lastTriedStatus: issue.status,
    betaReached: beta.status,
    closeShapeTriedAt: null,
    betaProjectSlug: twin.slug,
  });
  const held = issue.status === 'open' ? '' : ` (held at ${issue.status})`;
  const unread =
    beta.priority && !priority ? `; priority ${beta.priority} is not one here, filed medium` : '';
  ctx.report.ported.push(`${twin.slug}: beta ${beta.key} → ${devKey}${held}${unread}`);
  const commented = await postPeerComment(ctx.peer, beta.id, portedComment(devKey));
  if (!commented.ok) {
    ctx.report.refused.push(
      `${beta.key} comment "${portedComment(devKey)}": ${commented.refusal.code} (${commented.refusal.detail})`,
    );
  }
}
