// A release whose work lives on a storefront is proved by what the provider reports it publishes,
// never by a commit: a storefront keeps no deployment record and no commit. Each claimed issue's
// landing is the storefront draft its newest verdict judged (`storefront_draft` identity); the
// provider must publish that graph, or one that first went live after the landing was judged —
// the one mutable draft slot moved forward from it. Anything else is `RELEASE_NOT_VERIFIED`,
// naming the issue, the workflow and both identities.

import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issues } from '../db/schema.js';
import {
  getIntegration,
  readStorefrontPublished,
  type StorefrontPublishedReading,
} from '../integrations/index.js';
import { activeIssuePrefix, type CriterionWithVerdict, listCriteriaOf } from '../issues/index.js';
import { formatIssueRef } from '../lib/issue-ref.js';
import type { ReleaseChannel } from './plan.js';

/** One storefront workflow an issue landed: the draft its newest verdict on it judged, and when. */
export interface StorefrontLanding {
  issue: string;
  workflowId: string;
  draftVersion: string;
  judgedAt: string;
}

/** A landing what the provider publishes does not carry, or an issue that names no landing. */
export interface ProviderMismatch {
  issue: string;
  workflow: string | null;
  workflowCode: string | null;
  landed: string | null;
  served: string | null;
  why: string;
}

export type ProviderOutcome =
  | { ok: true; identity: string; readings: string[] }
  | { ok: false; reason: string; mismatches: ProviderMismatch[] };

export interface RosterCriteria {
  key: string;
  criteria: readonly CriterionWithVerdict[];
}

interface Landings {
  landings: StorefrontLanding[];
  /** Issues whose every verdict judged a design revision: they ship nothing a storefront serves. */
  shipsNothing: string[];
  unprovable: ProviderMismatch[];
}

/** Each issue's storefront landings from its criteria's latest verdicts, newest draft per workflow. */
export function landingsOf(roster: readonly RosterCriteria[]): Landings {
  const landings: StorefrontLanding[] = [];
  const shipsNothing: string[] = [];
  const unprovable: ProviderMismatch[] = [];
  for (const { key, criteria } of roster) {
    const latest = criteria.map((c) => c.latest);
    const byWorkflow = new Map<string, StorefrontLanding>();
    for (const v of latest) {
      if (v?.identityKind !== 'storefront_draft') continue;
      if (!v.storefrontWorkflowId || !v.storefrontDraftVersion) continue;
      const held = byWorkflow.get(v.storefrontWorkflowId);
      if (held && Date.parse(held.judgedAt) >= Date.parse(v.createdAt)) continue;
      byWorkflow.set(v.storefrontWorkflowId, {
        issue: key,
        workflowId: v.storefrontWorkflowId,
        draftVersion: v.storefrontDraftVersion.trim(),
        judgedAt: v.createdAt,
      });
    }
    if (byWorkflow.size > 0) {
      landings.push(...byWorkflow.values());
      continue;
    }
    if (latest.length > 0 && latest.every((v) => v?.identityKind === 'design')) {
      shipsNothing.push(key);
      continue;
    }
    const kinds = [...new Set(latest.map((v) => v?.identityKind ?? 'unjudged'))];
    unprovable.push({
      issue: key,
      workflow: null,
      workflowCode: null,
      landed: null,
      served: null,
      why:
        latest.length === 0
          ? `${key} has no criterion, so no verdict names the storefront draft it landed`
          : `${key}'s verdicts name no storefront draft (${kinds.join(', ')}), so nothing names the workflow and draft it landed`,
    });
  }
  return { landings, shipsNothing, unprovable };
}

type Judged = { carried: true; how: string } | { carried: false; mismatch: ProviderMismatch };

function judgeLanding(
  landing: StorefrontLanding,
  reading: StorefrontPublishedReading | undefined,
  label: string,
): Judged {
  const base = {
    issue: landing.issue,
    workflow: landing.workflowId,
    landed: landing.draftVersion,
  };
  const at = `workflow \`${landing.workflowId}\``;
  if (!reading || reading.kind === 'unreadable' || reading.kind === 'missing') {
    const why = reading?.detail ?? `${label} answered no reading of ${at}`;
    return { carried: false, mismatch: { ...base, workflowCode: null, served: null, why } };
  }
  const code = reading.workflowCode;
  if (reading.kind === 'unpublished') {
    return {
      carried: false,
      mismatch: {
        ...base,
        workflowCode: code,
        served: null,
        why: `${label} publishes no version of ${at} (\`${code}\`): nothing of it is live`,
      },
    };
  }
  const served = reading.graphVersion;
  if (served === landing.draftVersion) {
    return { carried: true, how: `serves draft \`${served}\` itself` };
  }
  const firstLive = Date.parse(reading.firstLiveAt);
  const judged = Date.parse(landing.judgedAt);
  if (firstLive > judged) {
    return {
      carried: true,
      how: `serves \`${served}\`, first live at ${reading.firstLiveAt}, after the landing was judged at ${landing.judgedAt}`,
    };
  }
  const revert =
    reading.firstLiveAt === reading.publishedAt
      ? ''
      : `, republished at ${reading.publishedAt} as a revert to a graph first live then`;
  return {
    carried: false,
    mismatch: {
      ...base,
      workflowCode: code,
      served,
      why: `${label} serves version ${reading.version} at \`${served}\`, live since ${reading.firstLiveAt}${revert}, which is not after the landing was judged at ${landing.judgedAt}, so the published graph cannot carry it`,
    },
  };
}

/** One sentence per mismatch, naming the issue, the resource and both identities. */
export function mismatchSentence(m: ProviderMismatch): string {
  if (m.workflow === null) return m.why;
  const code = m.workflowCode ? ` (\`${m.workflowCode}\`)` : '';
  return `${m.issue} landed workflow \`${m.workflow}\`${code} at draft \`${m.landed}\`, and ${m.why}`;
}

/** Every landing against what the provider publishes; green only where every one is carried. */
export function judgeProviderRecord(
  found: Landings,
  readings: ReadonlyMap<string, StorefrontPublishedReading>,
  label: string,
): ProviderOutcome {
  const mismatches = [...found.unprovable];
  const lines: string[] = [];
  for (const landing of found.landings) {
    const judged = judgeLanding(landing, readings.get(landing.workflowId), label);
    if (judged.carried) {
      lines.push(
        `${landing.issue}: workflow ${landing.workflowId} at draft ${landing.draftVersion} — ${label} ${judged.how}`,
      );
    } else {
      mismatches.push(judged.mismatch);
    }
  }
  if (mismatches.length > 0) {
    return {
      ok: false,
      reason: `what ${label} publishes does not carry ${mismatches.length} landing(s) of this release: ${mismatches.map(mismatchSentence).join('; ')}`,
      mismatches,
    };
  }
  if (found.landings.length === 0) {
    return {
      ok: false,
      reason: `no issue of this release landed a storefront draft, so nothing it carries can be checked against what ${label} publishes`,
      mismatches: [],
    };
  }
  const served = new Map<string, string>();
  for (const [id, r] of readings) {
    if (r.kind === 'published') served.set(id, `${id}@${r.graphVersion}`);
  }
  for (const key of found.shipsNothing) {
    lines.push(`${key}: judged on design revisions only; it ships nothing ${label} serves`);
  }
  return {
    ok: true,
    identity: [...served.values()].sort().join(', '),
    readings: lines,
  };
}

/** The issues a batch run still claims: the roster its finish closes. */
export async function rosterOfRun(runId: string): Promise<string[]> {
  const rows = await db
    .select({ id: issues.id })
    .from(issues)
    .where(eq(issues.releaseBatchRunId, runId));
  return rows.map((r) => r.id);
}

/**
 * Whether what production's storefront provider publishes, read once, now, carries every landing of
 * these issues.
 */
export async function verifyByProviderRecord(args: {
  projectId: string;
  issueIds: readonly string[];
  channel: ReleaseChannel;
}): Promise<ProviderOutcome> {
  const { projectId, channel } = args;
  const label = getIntegration(channel.provider)?.presentation?.label ?? channel.provider;
  if (args.issueIds.length === 0) {
    return {
      ok: false,
      reason: `this release claims no issue, so nothing it carries can be checked against what ${label} publishes`,
      mismatches: [],
    };
  }
  const [rows, prefix, criteria] = await Promise.all([
    db
      .select({ id: issues.id, seq: issues.issSeq })
      .from(issues)
      .where(and(eq(issues.projectId, projectId), inArray(issues.id, [...args.issueIds]))),
    activeIssuePrefix(projectId),
    listCriteriaOf(db, args.issueIds),
  ]);
  const roster = rows.map((r) => ({
    key: r.seq != null ? formatIssueRef(prefix, r.seq) : r.id,
    criteria: criteria.get(r.id) ?? [],
  }));
  const found = landingsOf(roster);
  const readings =
    found.landings.length === 0
      ? new Map<string, StorefrontPublishedReading>()
      : await readStorefrontPublished({
          provider: channel.provider,
          binding: channel.bindingId,
          workflowIds: found.landings.map((l) => l.workflowId),
        });
  return judgeProviderRecord(found, readings, label);
}
