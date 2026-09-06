/**
 * Assignment discovery (ISS-271): what one device serves, and everything the
 * runner on it needs to act — repo path, branch, project kind, setup prose, the
 * pacing hint for its master and the owner policy that master is briefed with.
 *
 * Its own module because every field here is half of a cross-language contract
 * the type checker cannot see, and the annotations that record them are longer
 * than the query.
 */

import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { projects, runners } from '../db/schema.js';

/** Seconds left on this runner's rate limit: `null` unlimited, `0` expired. */
// cm:edge contract -> packages/runner/crates/forge-runner-core/src/daemon/master.rs — the master paces its sweep off this number, and it must stay ADVISORY: absent has to mean "poll normally", never "stop". Core clears a limit only when a job SUCCEEDS (`clearRunnerLimit`), so a master that declined to sweep while limited would remove the only thing that can clear the stamp and no operator fixing the account out of band could restart the fleet.
// cm:guard send the REMAINING SECONDS, never the raw instant. The runner has no datetime crate, so a timestamp would import both a parser and every box's clock skew into a pacing decision; computed here it is one integer against one clock. An expired limit reads 0, which is the same answer as "not limited" — and that IS what a lapsed stamp means, because nothing clears the column until a job succeeds.
function rateLimitedForSecondsSql() {
  return sql<number | null>`CASE
    WHEN ${runners.rateLimitedUntil} IS NULL THEN NULL
    ELSE GREATEST(0, EXTRACT(EPOCH FROM (${runners.rateLimitedUntil} - now()))::int)
  END`;
}

/** The owner's standing instruction for this project's master, or `null`. */
// cm:why a `projectFacts` key rather than a column or a `pipelineConfig` field, because the owner edits this while a master is running and a schema field would cost a deploy per edit. `projectFacts` is already ≤8k free text with an MCP editor (`forge_config`), a web editor and no migration, and this value is prose an agent reads — the same shape as every other key in that map.
// cm:guard read it HERE, in the payload the daemon already fetches, and never from the master itself. A master is a tmux-parented Claude session started outside the job path: it holds no device token and makes no `/me/*` call, so a policy it had to fetch for itself would be a policy it silently ran without. ISS-929: the forge-dev policy was re-typed into the pane by hand twice and lost twice for exactly this reason.
function masterPolicySql() {
  return sql<string | null>`${projects.agentConfig}->'projectFacts'->>'master-policy'`;
}

/** Every `claude-code` runner row this device owns, joined to its project. */
export async function listDeviceAssignments(deviceId: string) {
  return db
    .select({
      projectId: runners.projectId,
      runnerId: runners.id,
      slug: projects.slug,
      baseBranch: projects.baseBranch,
      repoPath: runners.repoPath,
      branch: runners.branch,
      status: runners.status,
      // cm:edge contract -> packages/runner/crates/forge-runner-core/src/transport/runners.rs — `MeRunner.kind` deserializes this field, and `requires_preflight` decides from it whether a job runs the git preflight at all. Dropping it here does not fail any type check: the runner defaults a missing field to None and then REQUIRES preflight, so a storefront project silently goes back to failing every job on `origin_remote`.
      kind: projects.kind,
      // cm:edge contract -> packages/runner/crates/forge-runner-core/src/daemon/setup_agent.rs — the setup agent's procedure comes from here and nowhere else. Same silent-failure shape as `kind` above: the runner defaults it to None and falls back to deriving the procedure per job, so dropping this field costs tokens on every repair instead of failing anything.
      workspaceSetup: projects.workspaceSetup,
      // cm:edge contract -> packages/runner/crates/forge-runner-core/src/daemon/master.rs — `standing_prompt` splices this into the brief a resident master is given once per session, and it is the ONLY delivery: the skill in the binary carries the defaults, this carries what the owner decided. Dropping it fails no type check — the runner reads a missing field as `None` and the master falls back to the skill's own defaults, which is the silent half of the bug ISS-929 fixed.
      masterPolicy: masterPolicySql(),
      rateLimitedForSeconds: rateLimitedForSecondsSql(),
      limitReason: runners.limitReason,
    })
    .from(runners)
    .innerJoin(projects, eq(projects.id, runners.projectId))
    .where(and(eq(runners.deviceId, deviceId), eq(runners.type, 'claude-code')));
}
