// The environment a judge reads its testing secrets for, named off the issue it judges: the release
// that carried its work to production, else its landing, else (a declared run over an issue with
// nothing landed) the environment the run names or the one the project is judged on.

import { judgedOnOf } from '@forge/contracts/delivery-policy';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issues } from '../db/schema.js';
import { projectConfigPorts } from './ports.js';
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

/** What named the environment a judge reads for: the issue's landing, the shipped release that
 *  carried it (ISS-1407), the declared run itself (an issue with nothing landed, ISS-1407), or the
 *  environment the project judges its work on. */
export type JudgedBasis = 'landing' | 'release' | 'named' | JudgingEnvironment['basis'];

/** The environment a judge reads for, its testing profile, and what named it, in words a refusal
 *  quotes (`namedBy`). */
export interface Judged {
  ok: true;
  environment: string;
  testing: string;
  basis: JudgedBasis;
  namedBy: string;
}

type JudgedRead = Refused | Judged;

/** The sentence every TESTING_PROFILE_NOT_NAMED refusal says: which environment, what named it, and
 *  which profile that environment names instead of the one asked for (ISS-1407 c3). */
export function profileNotNamedSaid(judge: string, judged: Judged, asked: string): string {
  return `environment \`${judged.environment}\`, which ${judge} judges as named by ${judged.namedBy}, names testing profile \`${judged.testing}\`, not \`${asked}\`.`;
}

// the environment a job judges is the one deploying the branch its issue's work landed on —
// the target the merge mark recorded — so no deployment is read and no dispatcher writes a field.
// Where several deploy that branch, the testing profile the caller names picks the one that names
// it; the read stays refused by name where none or more than one does. With `unmarked: 'judging'`
// (a declared run, ISS-1379), an issue carrying no merge mark at all — a docs or screenshot issue
// whose work lands nowhere — is judged on the environment the run names (`named`, ISS-1407), else on
// `judgingEnvironmentOf`, as a requirement run is, and no mark is written; a mark standing with no
// target keeps its refusal. An issue a shipped release carried is judged on production, where that
// release deployed it, whenever production names a testing profile (ISS-1407): its landing's
// environment is read instead only where its profile is the one asked for and production's is not,
// so a judge of the landed build before that release is never turned away.
export async function judgedEnvironment(
  issueId: string | null,
  document: ProjectDocument,
  judge: string,
  profileId: string,
  opts: { unmarked?: 'refuse' | 'judging'; named?: string | null } = {},
): Promise<JudgedRead> {
  const [issue] = issueId
    ? await db
        .select({
          projectId: issues.projectId,
          mergedAt: issues.mergedAt,
          target: issues.mergedTarget,
        })
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
  const id = issueId as string;
  const named = opts.named ?? null;
  const released = await releasedEnvironment(issue.projectId, id, document);
  if (released && (named === null || named === released.environment)) {
    if (released.testing === profileId || named !== null) return released;
  }
  const landed = await landedEnvironment(id, issue, document, profileId, opts);
  if (named !== null) {
    if (landed.ok && landed.basis !== 'named' && landed.environment !== named) {
      const on = (j: Judged) => `\`${j.environment}\` (named by ${j.namedBy})`;
      return refuse(
        422,
        'TESTING_ENVIRONMENT_NOT_JUDGED',
        `${judge} named environment \`${named}\`, and issue ${id}'s work is read on ${released ? `${on(released)} or ${on(landed)}` : on(landed)}: a run names the environment it reads only for an issue whose work has not landed. Read again without \`environment\`, or naming the one its work is on. Nothing was read.`,
        {
          named,
          judged: released ? [released.environment, landed.environment] : [landed.environment],
        },
      );
    }
    return landed;
  }
  if (released && !(landed.ok && landed.testing === profileId)) return released;
  return landed;
}

/** The production environment a shipped release carried the issue to, where it names a testing
 *  profile; null where no shipped release holds the issue's work, or production names none. */
async function releasedEnvironment(
  projectId: string,
  issueId: string,
  document: ProjectDocument,
): Promise<Judged | null> {
  const production = productionOf(document);
  const testing = production?.declaration.testing;
  if (!production || !testing) return null;
  const shipped = await projectConfigPorts().shippedReleaseOf(projectId, issueId);
  if (!shipped) return null;
  return {
    ok: true,
    environment: production.name,
    testing,
    basis: 'release',
    namedBy: `release ${shipped.version}, which carried issue ${issueId} to production`,
  };
}

/** The environment the issue's own landing names: its merge-mark target's, or with nothing landed
 *  (a declared run), the one the run names or the project's fallback. */
async function landedEnvironment(
  issueId: string,
  issue: { mergedAt: Date | null; target: string | null },
  document: ProjectDocument,
  profileId: string,
  opts: { unmarked?: 'refuse' | 'judging'; named?: string | null },
): Promise<JudgedRead> {
  if (!issue.target && !issue.mergedAt && opts.unmarked === 'judging') {
    return opts.named
      ? namedEnvironment(issueId, document, opts.named)
      : judgingFallback(issueId, document);
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
  const namedBy = `its merge-mark target \`${target}\``;
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
    const [picked, ...alsoNamed] = naming;
    if (picked && alsoNamed.length === 0) {
      return { ok: true, environment: picked.name, testing: profileId, basis: 'landing', namedBy };
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
    namedBy,
  };
}

/** An issue with nothing landed, read by a declared run naming the environment it reads (ISS-1407
 *  c4): only an environment the document declares, and only the testing profile it names. */
function namedEnvironment(issueId: string, document: ProjectDocument, named: string): JudgedRead {
  const environments = environmentsOf(document);
  const environment = environments.find((e) => e.name === named);
  if (!environment) {
    return refuse(
      422,
      'TESTING_ENVIRONMENT_UNDECLARED',
      `the run named environment \`${named}\` to read for issue ${issueId}, and the project document declares no such environment; it declares ${environments.map((e) => `\`${e.name}\``).join(', ') || 'none'}. Nothing was read.`,
      { named, declared: environments.map((e) => e.name) },
    );
  }
  if (!environment.declaration.testing) {
    return refuse(
      404,
      'TESTING_SECRETS_NO_TESTING_PROFILE',
      `environment \`${named}\`, which the run named to read for issue ${issueId} (its work having landed nowhere), names no testing profile (\`environments.${named}.testing\`). Nothing was read.`,
    );
  }
  return {
    ok: true,
    environment: named,
    testing: environment.declaration.testing,
    basis: 'named',
    namedBy: `the run, which named it for issue ${issueId}, whose work has landed nowhere`,
  };
}

/** An issue with no merge mark, read by a declared run: the environment the project is judged on. */
function judgingFallback(issueId: string, document: ProjectDocument): JudgedRead {
  const judging = judgingEnvironmentOf(document);
  if (!judging) {
    return refuse(
      422,
      'TESTING_SECRETS_NOT_LANDED',
      `issue ${issueId}: its work has not landed (no merge mark), and the project names no environment its work is judged on: no \`delivery.judgedOn\` and no production environment. Where its work lands, mark it merged with its target first. Where it has nothing to land (a docs or screenshot issue, an investigation), name the environment to read with \`environment\`, or the one this project is judged on in \`delivery.judgedOn\`, and read again; no merge mark is needed. Nothing was read.`,
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
  return {
    ok: true,
    environment: judging.name,
    testing: judging.testing,
    basis: judging.basis,
    namedBy: `the fallback, ${said}, issue ${issueId}'s work having landed nowhere`,
  };
}
