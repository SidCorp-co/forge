// A landing artifact one issue touched but another issue's own release ships: "carried by ISS-N".
// It is said on the mark (`artifacts[].carriedBy`), never inferred from prose or from what the
// provider leaves unpublished. The mark stores the carrier's key in the same project; a release of
// the carrying-from issue reports the artifact carried, and the carrier's landing inherits it, so
// the carrier's own release verifies it.

import { ISSUE_TERMINAL_STATUSES, type IssueStatus } from '@forge/contracts/issue-machine';
import type { MergeRefusalCode } from '@forge/contracts/issues';
import type { LandingArtifact } from '@forge/contracts/landing-artifacts';
import { and, eq, isNotNull, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issues } from '../db/schema.js';
import { formatIssueRef, parseIssueRef } from '../lib/issue-ref.js';
import { activeIssuePrefix, heldIssuePrefixes } from './issue-prefix-read.js';
import { isUuid } from './issue-route-ref.js';

/** A carrier that has closed or dropped: no release of it will ship anything more. */
export const carrierEnded = (status: string) =>
  (ISSUE_TERMINAL_STATUSES as readonly string[]).includes(status as IssueStatus);

/** The issue a `carriedBy` names in this project, or why it names none. */
export interface Carrier {
  id: string;
  key: string;
  status: string;
}

type CarrierRead = { ok: true; carrier: Carrier } | { ok: false; why: string };

async function readCarrier(projectId: string, raw: string): Promise<CarrierRead> {
  const named = raw.trim();
  const [prefix, held] = await Promise.all([
    activeIssuePrefix(projectId),
    heldIssuePrefixes(projectId),
  ]);
  let where: ReturnType<typeof and>;
  if (isUuid(named)) where = eq(issues.id, named);
  else {
    const parsed = parseIssueRef(named, held);
    if (!parsed.ok) {
      return {
        ok: false,
        why:
          parsed.code === 'FOREIGN_PREFIX'
            ? `\`${named}\` is not a key of this project: a carrier is an issue of the same project`
            : parsed.message,
      };
    }
    where = and(eq(issues.projectId, projectId), eq(issues.issSeq, parsed.issSeq));
  }
  const [row] = await db
    .select({
      id: issues.id,
      projectId: issues.projectId,
      seq: issues.issSeq,
      status: issues.status,
    })
    .from(issues)
    .where(where)
    .limit(1);
  if (!row) return { ok: false, why: `\`${named}\` names no issue in this project` };
  if (row.projectId !== projectId) {
    return {
      ok: false,
      why: `\`${named}\` is an issue of another project: a carrier is an issue of the same project`,
    };
  }
  return {
    ok: true,
    carrier: { id: row.id, key: formatIssueRef(prefix, row.seq), status: row.status },
  };
}

export type CarriageRefusal = {
  ok: false;
  code: Extract<MergeRefusalCode, `ARTIFACT_CARRIER_${string}`>;
  detail: string;
  index: number;
};

/**
 * The artifacts a mark sends, each `carriedBy` resolved to the carrier's key in this project, or
 * the first refusal: a design revision is never carried, and the carrier must be another issue of
 * this project that has not closed or dropped (one that has can no longer ship it).
 */
export async function resolveCarriage(args: {
  issueId: string;
  projectId: string;
  artifacts: readonly LandingArtifact[];
}): Promise<{ ok: true; artifacts: LandingArtifact[] } | CarriageRefusal> {
  const out: LandingArtifact[] = [];
  for (const [index, a] of args.artifacts.entries()) {
    if (a.carriedBy === undefined) {
      out.push(a);
      continue;
    }
    const nothing = 'so nothing was marked';
    if (a.surface === 'design') {
      return {
        ok: false,
        code: 'ARTIFACT_CARRIER_DESIGN',
        detail: `artifact ${index} (\`${a.ref}\`) is a design revision, which deploys nothing for another issue to ship, and it names carrier \`${a.carriedBy}\`, ${nothing}. Send it without \`carriedBy\`.`,
        index,
      };
    }
    const read = await readCarrier(args.projectId, a.carriedBy);
    if (!read.ok) {
      return {
        ok: false,
        code: 'ARTIFACT_CARRIER_UNKNOWN',
        detail: `artifact ${index} (\`${a.ref}\`) is marked carried by \`${a.carriedBy}\`, and ${read.why}, ${nothing}.`,
        index,
      };
    }
    const { carrier } = read;
    if (carrier.id === args.issueId) {
      return {
        ok: false,
        code: 'ARTIFACT_CARRIER_SELF',
        detail: `artifact ${index} (\`${a.ref}\`) is marked carried by ${carrier.key}, the issue being marked; an artifact this issue ships is its own landing, ${nothing}. Send it without \`carriedBy\`.`,
        index,
      };
    }
    if (carrierEnded(carrier.status)) {
      return {
        ok: false,
        code: 'ARTIFACT_CARRIER_SHIPPED',
        detail: `artifact ${index} (\`${a.ref}\`) is marked carried by ${carrier.key}, which is \`${carrier.status}\`, so no release of it will ship this artifact, ${nothing}. Name an open issue whose release ships it, or mark it as this issue's own.`,
        index,
      };
    }
    out.push({ ...a, carriedBy: carrier.key });
  }
  return { ok: true, artifacts: out };
}

/** What each stored `carriedBy` key names in this project now, or why it names nothing. */
export async function readCarriers(
  projectId: string,
  keys: readonly string[],
): Promise<Map<string, CarrierRead>> {
  const unique = [...new Set(keys)];
  const reads = await Promise.all(unique.map((k) => readCarrier(projectId, k)));
  return new Map(unique.map((k, i) => [k, reads[i] as CarrierRead]));
}

/** One artifact another issue's mark says this issue carries. */
export interface InheritedArtifact {
  carrierId: string;
  fromId: string;
  fromKey: string;
  /** When the carrying-from issue's mark was stamped: the time the artifact was recorded. */
  mergedAt: Date | null;
  artifact: LandingArtifact;
}

/** Every artifact the project's marks say these carriers carry: their landings inherit them. */
export async function artifactsCarriedFor(
  projectId: string,
  carrierIds: readonly string[],
): Promise<InheritedArtifact[]> {
  if (carrierIds.length === 0) return [];
  const rows = await db
    .select({
      id: issues.id,
      seq: issues.issSeq,
      mergedAt: issues.mergedAt,
      artifacts: issues.mergedArtifacts,
    })
    .from(issues)
    .where(
      and(
        eq(issues.projectId, projectId),
        isNotNull(issues.mergedArtifacts),
        sql`jsonb_path_exists(${issues.mergedArtifacts}, '$[*] ? (exists(@.carriedBy))')`,
      ),
    );
  const keys = rows.flatMap((r) => (r.artifacts ?? []).flatMap((a) => a.carriedBy ?? []));
  if (keys.length === 0) return [];
  const [prefix, carriers] = await Promise.all([
    activeIssuePrefix(projectId),
    readCarriers(projectId, keys),
  ]);
  const wanted = new Set(carrierIds);
  return rows.flatMap((r) =>
    (r.artifacts ?? []).flatMap((artifact): InheritedArtifact[] => {
      const read = artifact.carriedBy ? carriers.get(artifact.carriedBy) : undefined;
      if (!read?.ok || !wanted.has(read.carrier.id)) return [];
      return [
        {
          carrierId: read.carrier.id,
          fromId: r.id,
          fromKey: formatIssueRef(prefix, r.seq),
          mergedAt: r.mergedAt,
          artifact,
        },
      ];
    }),
  );
}

/** What an issue's detail says of carriage: what others carry for it, and what it carries for others. */
export interface IssueCarriage {
  carriedBy: Array<{ ref: string; issue: string }>;
  carries: Array<{ ref: string; from: string }>;
}

export async function carriageOfIssue(issue: {
  id: string;
  projectId: string;
  mergedArtifacts: readonly LandingArtifact[] | null;
}): Promise<IssueCarriage> {
  const carriedBy = (issue.mergedArtifacts ?? []).flatMap((a) =>
    a.carriedBy ? [{ ref: a.ref, issue: a.carriedBy }] : [],
  );
  const carries = (await artifactsCarriedFor(issue.projectId, [issue.id])).map((c) => ({
    ref: c.artifact.ref,
    from: c.fromKey,
  }));
  return { carriedBy, carries };
}
