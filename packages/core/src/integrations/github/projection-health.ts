/**
 * ISS-1123 — whether the projection has ever been written to, and the sentence that says it has not.
 *
 * An empty `repo_pull_requests` reads two ways and only one of them is the caller's fault. A
 * project with no pull requests is an ordinary state; a project whose projection nothing has ever
 * written to is a broken pipe, and answering a merge there with "this issue has no pull request
 * #534" sends an operator to check the number rather than the pipe. This is the reading that tells
 * them apart, and it is the same reading the binding report serves to `forge_github list`.
 */

import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { integrationBindings } from '../../db/schema.js';
import { repoPullRequests } from '../../db/schema-repo-projection.js';
import { readInboundDoorTraffic } from '../inbound-door.js';

/** How many inbound deliveries have come through one binding's door, and when the last one did. */
export interface InboundDeliveryReport {
  count: number;
  lastAt: Date | null;
}

export interface ProjectionPipeReport {
  projectId: string;
  /** Rows in `repo_pull_requests` for this project, of any state. */
  rows: number;
  /** GitHub bindings this project holds, active or not. */
  bindings: number;
  inbound: InboundDeliveryReport;
}

/**
 * Deliveries that came THROUGH the door, which is not every inbound row.
 *
 * ISS-1140 gave a call turned away at the door a row of its own, and counting those here would
 * say a door had opened when what actually happened is that something knocked and was refused —
 * the same false green this module exists to refuse, wearing a new cause. `inbound-door.ts` is
 * the one reader of that table for this fact and this defers to it.
 */
async function inboundDeliveriesForBinding(bindingId: string): Promise<InboundDeliveryReport> {
  const traffic = await readInboundDoorTraffic(bindingId);
  return { count: traffic.accepted, lastAt: traffic.lastAcceptedAt };
}

/** What this project's projection holds, and what has reached the door that writes it. */
export async function projectionPipeReport(projectId: string): Promise<ProjectionPipeReport> {
  const [rowCount] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(repoPullRequests)
    .where(eq(repoPullRequests.projectId, projectId));

  const bindings = await db
    .select({ id: integrationBindings.id })
    .from(integrationBindings)
    .where(
      and(eq(integrationBindings.projectId, projectId), eq(integrationBindings.provider, 'github')),
    )
    .orderBy(desc(integrationBindings.createdAt));

  let count = 0;
  let lastAt: Date | null = null;
  for (const binding of bindings) {
    const seen = await inboundDeliveriesForBinding(binding.id);
    count += seen.count;
    if (seen.lastAt && (!lastAt || seen.lastAt > lastAt)) lastAt = seen.lastAt;
  }

  return {
    projectId,
    rows: Number(rowCount?.n ?? 0),
    bindings: bindings.length,
    inbound: { count, lastAt },
  };
}

/**
 * The sentence a caller meets when the projection holds nothing, or null when it holds something.
 *
 * The condition is the empty projection ALONE. A project that has received deliveries and still
 * holds no row is the same broken pipe wearing a different cause, so it gets this refusal with that
 * cause in it rather than falling back to a sentence about a pull request number.
 *
 * The count is of deliveries RECORDED, and the sentence says so rather than saying GitHub never
 * called. `POST /api/webhooks/in/:slug` turns away a request whose signature does not verify before
 * anything records it, so a wrong or rotated webhook secret produces a zero here that is
 * indistinguishable from a door nobody knocked on. Telling an operator GitHub never called would
 * send them to the wrong half of the pipe.
 */
export function describeEmptyProjection(report: ProjectionPipeReport): string | null {
  if (report.rows > 0) return null;
  const door =
    report.inbound.count === 0
      ? `Forge has recorded no webhook delivery at all on ${report.bindings === 1 ? 'its GitHub binding' : `any of its ${report.bindings} GitHub bindings`} — either GitHub has never called, or its calls are being turned away before they are recorded, which is what a wrong or rotated webhook secret looks like from here`
      : `Forge has recorded ${report.inbound.count} inbound deliver${report.inbound.count === 1 ? 'y' : 'ies'} on its GitHub bindings, the last at ${report.inbound.lastAt?.toISOString() ?? 'a time nothing recorded'}, and none of them wrote a pull request`;
  const bound =
    report.bindings === 0
      ? 'this project has bound no GitHub repository, so nothing could write one'
      : door;
  return (
    "Forge's projection of this repository holds no pull request at all for this project, so there is " +
    'nothing here to merge. That is a projection nothing has written to, not a repository with no pull ' +
    `requests: ${bound}. A row is written when Forge opens a pull request through \`forge_github ` +
    'open-pull-request`, and when a `pull_request` delivery reaches `POST /api/webhooks/in/<project ' +
    'slug>`. A pull request opened before either of those wrote anything leaves no row, and Forge will ' +
    'not merge what it has no record of.'
  );
}
