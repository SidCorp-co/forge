// The environment a judge reads its testing secrets for, named off the landing of the issue it judges.

import { judgedOnOf } from '@forge/contracts/delivery-policy';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issues } from '../db/schema.js';
import { environmentsOf, productionOf } from './release-path.js';
import type { ProjectDocument } from './schema.js';
import { type Refused, refuse } from './testing-secret-values.js';

/**
 * The environment a project judges its released work on, with no issue's landing to name one: the
 * one `delivery.judgedOn` names, else production, with the testing profile it names (null where it
 * names none). Null where the project names neither.
 */
export interface JudgingEnvironment {
  name: string;
  basis: 'judgedOn' | 'production';
  testing: string | null;
}

export function judgingEnvironmentOf(document: ProjectDocument): JudgingEnvironment | null {
  const judgedOn = judgedOnOf(document.delivery);
  const name = judgedOn ?? productionOf(document)?.name ?? null;
  if (!name) return null;
  const testing = environmentsOf(document).find((e) => e.name === name)?.declaration.testing;
  return { name, basis: judgedOn ? 'judgedOn' : 'production', testing: testing ?? null };
}

/** Where the environment a judge reads for was named from: the issue's landing, or (an issue with
 *  nothing landed, read by a declared run) the environment the project judges its work on. */
type JudgedBasis = 'landing' | JudgingEnvironment['basis'];

// the environment a job judges is the one deploying the branch its issue's work landed on —
// the target the merge mark recorded — so no deployment is read and no dispatcher writes a field.
// Where several deploy that branch, the testing profile the caller names picks the one that names
// it; the read stays refused by name where none or more than one does. With `unmarked: 'judging'`
// (a declared run, ISS-1379), an issue carrying no merge mark at all — a docs or screenshot issue
// whose work lands nowhere — is judged on `judgingEnvironmentOf`, as a requirement run is, and no
// mark is written; a mark standing with no target keeps its refusal.
export async function judgedEnvironment(
  issueId: string | null,
  document: ProjectDocument,
  judge: string,
  profileId: string,
  opts: { unmarked?: 'refuse' | 'judging' } = {},
): Promise<Refused | { ok: true; environment: string; testing: string; basis: JudgedBasis }> {
  const [issue] = issueId
    ? await db
        .select({ mergedAt: issues.mergedAt, target: issues.mergedTarget })
        .from(issues)
        .where(eq(issues.id, issueId))
        .limit(1)
    : [];
  if (!issue) {
    return refuse(
      422,
      'TESTING_SECRETS_NOT_LANDED',
      `${judge} works no issue, so no landed work names the environment it judges.`,
    );
  }
  if (!issue.target && !issue.mergedAt && opts.unmarked === 'judging') {
    return judgingFallback(issueId as string, document);
  }
  if (!issue.target) {
    // a mark already standing is refused MARK_ALREADY_STANDS, so the way out names the clear first
    const why = issue.mergedAt
      ? 'its merge mark names no target branch'
      : 'its work has not landed (no merge mark)';
    const wayOut = issue.mergedAt
      ? `Clear the standing mark (DELETE /api/issues/${issueId}/merge), then mark it again naming its target.`
      : 'Mark it merged with its target first.';
    return refuse(
      422,
      'TESTING_SECRETS_NOT_LANDED',
      `issue ${issueId}: ${why}, so no environment deploying it can be named. ${wayOut}`,
    );
  }
  const target = issue.target;
  const deploying = environmentsOf(document).filter((e) => e.declaration.deploysFrom === target);
  const [only, ...others] = deploying;
  if (!only) {
    return refuse(
      422,
      'TESTING_SECRETS_NO_ENVIRONMENT_FOR_TARGET',
      `issue ${issueId} landed on \`${target}\`, and no environment of this project deploys from it.`,
      { target },
    );
  }
  if (others.length > 0) {
    const naming = deploying.filter((e) => e.declaration.testing === profileId);
    const [named, ...alsoNamed] = naming;
    if (named && alsoNamed.length === 0) {
      return { ok: true, environment: named.name, testing: profileId, basis: 'landing' };
    }
    const listed = deploying
      .map(
        (e) =>
          `${e.name} (testing ${e.declaration.testing ? `\`${e.declaration.testing}\`` : 'none'})`,
      )
      .join(', ');
    const why =
      naming.length === 0
        ? `none of them names testing profile \`${profileId}\``
        : `${naming.length} of them name testing profile \`${profileId}\``;
    return refuse(
      422,
      'TESTING_SECRETS_ENVIRONMENT_AMBIGUOUS',
      `${deploying.length} environments deploy from \`${target}\`: ${listed}, and ${why}, so the one issue ${issueId} is judged on cannot be named. Ask for the profile exactly one of them names.`,
      { target, environments: deploying.map((e) => e.name) },
    );
  }
  if (!only.declaration.testing) {
    return refuse(
      404,
      'TESTING_SECRETS_NO_TESTING_PROFILE',
      `environment \`${only.name}\`, which deploys \`${target}\`, names no testing profile (\`environments.${only.name}.testing\`).`,
    );
  }
  return {
    ok: true,
    environment: only.name,
    testing: only.declaration.testing,
    basis: 'landing',
  };
}

/** An issue with no merge mark, read by a declared run: the environment the project is judged on. */
function judgingFallback(
  issueId: string,
  document: ProjectDocument,
): Refused | { ok: true; environment: string; testing: string; basis: JudgedBasis } {
  const judging = judgingEnvironmentOf(document);
  if (!judging) {
    return refuse(
      422,
      'TESTING_SECRETS_NOT_LANDED',
      `issue ${issueId}: its work has not landed (no merge mark), and the project names no environment its work is judged on: no \`delivery.judgedOn\` and no production environment. Where its work lands, mark it merged with its target first. Where it has nothing to land (a docs or screenshot issue), name the environment this project is judged on in \`delivery.judgedOn\` and read again; no merge mark is needed. Nothing was read.`,
    );
  }
  const said = judging.basis === 'judgedOn' ? 'delivery.judgedOn' : 'its production environment';
  if (!judging.testing) {
    return refuse(
      404,
      'TESTING_SECRETS_NO_TESTING_PROFILE',
      `environment \`${judging.name}\`, which issue ${issueId} is judged on (${said}, its work having landed nowhere), names no testing profile (\`environments.${judging.name}.testing\`).`,
    );
  }
  return { ok: true, environment: judging.name, testing: judging.testing, basis: judging.basis };
}
