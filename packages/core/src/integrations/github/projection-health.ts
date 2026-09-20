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
import { integrationBindings, integrationDeliveries } from '../../db/schema.js';
import { repoPullRequests } from '../../db/schema-repo-projection.js';

/** How many inbound deliveries have reached one binding, and when the last one did. */
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

export async function inboundDeliveriesForBinding(
  bindingId: string,
): Promise<InboundDeliveryReport> {
  const [row] = await db
    .select({
      n: sql<number>`count(*)::int`,
      last: sql<Date | null>`max(${integrationDeliveries.createdAt})`,
    })
    .from(integrationDeliveries)
    .where(
      and(
        eq(integrationDeliveries.bindingId, bindingId),
        eq(integrationDeliveries.direction, 'inbound'),
      ),
    );
  return { count: Number(row?.n ?? 0), lastAt: row?.last ? new Date(row.last) : null };
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
 */
export function describeEmptyProjection(report: ProjectionPipeReport): string | null {
  if (report.rows > 0) return null;
  const door =
    report.inbound.count === 0
      ? `no webhook delivery has ever reached ${report.bindings === 1 ? 'its GitHub binding' : `any of its ${report.bindings} GitHub bindings`}`
      : `${report.inbound.count} inbound deliver${report.inbound.count === 1 ? 'y has' : 'ies have'} reached its GitHub bindings, the last at ${report.inbound.lastAt?.toISOString() ?? 'a time nothing recorded'}, and none of them wrote a pull request`;
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
