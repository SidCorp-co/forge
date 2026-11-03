// One `beta_port` fire (ISS-923, owner ruling 2026-11-03 `beta-issues-are-worked-on-dev`): every
// forge-beta issue not yet ported becomes an open issue in the same-slug project here, and every
// ported pair's dev status is mirrored back onto beta once. Core runs it inline: no box, no session.
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
  postPeerComment,
  transitionPeerIssue,
} from '../integrations/peer-forge/index.js';
import { createIssue, issueIdOfKey } from '../issues/index.js';
import { formatIssueRef } from '../lib/issue-ref.js';
import { logger } from '../lib/logger.js';
import { isRefusal } from '../lib/refusal.js';
import { readProjectSecrets } from '../project-config/index.js';
import {
  firstLineNamesBetaIssue,
  isPortedMarker,
  markerDevKey,
  mirrorReason,
  mirrorRefusedComment,
  mirrorTarget,
  portedComment,
  portedFirstLine,
  UNPORTED_BETA_STATUSES,
} from './markers.js';
import { type BetaPortReport, emptyReport, renderReport, reportSaysSomething } from './report.js';
import {
  type DevIssue,
  type DevTwin,
  devFirstLines,
  devIssuesById,
  devTwinsBySlug,
  type Pair,
  pairsOf,
  recordMirrored,
  recordPair,
} from './store.js';

/** At most this many beta issues are ported by one fire; the rest are the next fire's. */
export const MAX_PORTS_PER_FIRE = 25;
/** At most this many mirror moves are tried by one fire; the rest are the next fire's. */
export const MAX_MIRRORS_PER_FIRE = 50;

export const BETA_URL_REF = secretRefOf(BETA_PORT_SECRET_SCOPE, BETA_PORT_SECRET_NAMES.url);
export const BETA_TOKEN_REF = secretRefOf(BETA_PORT_SECRET_SCOPE, BETA_PORT_SECRET_NAMES.token);

export type BetaPortOutcome =
  | { kind: 'refused'; code: BetaPortFireRefusal; detail: string }
  | { kind: 'ran'; changed: boolean; output: string; report: BetaPortReport };

interface Budget {
  ports: number;
  mirrors: number;
}

interface FireContext {
  peer: PeerForge;
  fireId: string;
  report: BetaPortReport;
  budget: Budget;
}

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

export async function runBetaPort(args: {
  projectId: string;
  fireId: string;
}): Promise<BetaPortOutcome> {
  const secrets = await readProjectSecrets(args.projectId, [BETA_URL_REF, BETA_TOKEN_REF]);
  if (!secrets.ok) {
    return {
      kind: 'refused',
      code: 'BETA_PORT_SECRET_MISSING',
      detail: `${secrets.refs.join(' and ')} ${secrets.code === 'SECRET_VALUE_MISSING' ? 'is not set' : 'does not decrypt under this core'} on this project: PUT /api/projects/${args.projectId}/secrets/${BETA_PORT_SECRET_SCOPE}/<name> for each. Nothing was read from forge-beta and nothing was created.`,
    };
  }
  const token = secrets.values.get(BETA_TOKEN_REF) as string;
  const peer: PeerForge = { baseUrl: secrets.values.get(BETA_URL_REF) as string, token };
  const scrub = (text: string) => scrubLogText(text, [token]);

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
    report: emptyReport(),
    budget: { ports: MAX_PORTS_PER_FIRE, mirrors: MAX_MIRRORS_PER_FIRE },
  };
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
    ported: report.ported.map(scrub),
    mirrored: report.mirrored.map(scrub),
    refused: report.refused.map(scrub),
    skipped: report.skipped.map(scrub),
    noTwin: report.noTwin.map(scrub),
    waiting: report.waiting,
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

  for (const beta of betaIssues) {
    if (pairs.has(beta.id) || UNPORTED_BETA_STATUSES.has(beta.status)) continue;
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

  await mirrorProject(ctx, twin, betaIssues, pairs);
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
  };
  await recordPair({ ...pair, betaProjectSlug: twin.slug });
  return pair;
}

const DEV_PRIORITIES: ReadonlySet<string> = new Set(issuePriorities);

async function portOne(ctx: FireContext, beta: PeerIssue, twin: DevTwin): Promise<void> {
  const priority = beta.priority && DEV_PRIORITIES.has(beta.priority) ? beta.priority : undefined;
  const body = beta.description?.trim();
  let created: Awaited<ReturnType<typeof createIssue>>;
  try {
    created = await createIssue(
      {
        projectId: twin.id,
        title: beta.title,
        description: [portedFirstLine(beta.key, beta.id), ...(body ? ['', body] : [])].join('\n'),
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
    ctx.report.refused.push(`${beta.key} → ${twin.slug}: ${code} (${errText(err)})`);
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
    betaProjectSlug: twin.slug,
  });
  const held = issue.status === 'open' ? '' : ` (held at ${issue.status})`;
  const unread =
    beta.priority && !priority ? `; priority ${beta.priority} is not one here, filed medium` : '';
  ctx.report.ported.push(`${beta.key} → ${devKey}${held}${unread}`);
  const commented = await postPeerComment(ctx.peer, beta.id, portedComment(devKey));
  if (!commented.ok) {
    ctx.report.refused.push(
      `${beta.key} comment "${portedComment(devKey)}": ${commented.refusal.code} (${commented.refusal.detail})`,
    );
  }
}

async function mirrorProject(
  ctx: FireContext,
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
    if (!dev || dev.status === pair.lastMirroredStatus) continue;
    const target = mirrorTarget(dev.status);
    if (target === null || target === beta.status) {
      await recordMirrored(beta.id, dev.status);
      continue;
    }
    if (ctx.budget.mirrors <= 0) {
      ctx.report.waiting += 1;
      continue;
    }
    ctx.budget.mirrors -= 1;
    const moved = await transitionPeerIssue(
      ctx.peer,
      beta.id,
      target,
      mirrorReason(dev.key, dev.status),
    );
    if (moved.ok) {
      ctx.report.mirrored.push(`${dev.key}: ${beta.status} → ${target} (${beta.key})`);
    } else {
      const code = moved.refusal.code;
      ctx.report.refused.push(`${dev.key} → ${beta.key} ${target}: ${code}`);
      const told = await postPeerComment(
        ctx.peer,
        beta.id,
        mirrorRefusedComment(dev.key, dev.status, code),
      );
      if (!told.ok) {
        ctx.report.refused.push(`${beta.key} refusal comment: ${told.refusal.code}`);
      }
    }
    // recorded either way, so the same move is never tried or commented twice
    await recordMirrored(beta.id, dev.status);
  }
}
