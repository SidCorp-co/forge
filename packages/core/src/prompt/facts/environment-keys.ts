import { JUDGING_JOB_TYPES, SELF_JOB } from '@forge/contracts/project-config';
import { environmentsOf } from '../../project-config/release-path.js';
import type { ProjectDocument, TestingProfile } from '../../project-config/schema.js';

/** Every environment's address, each line naming the environment and its tier. */
export function renderTestUrls(document: ProjectDocument | null): string | undefined {
  if (!document) return undefined;
  const lines: string[] = [];
  for (const { name, declaration } of environmentsOf(document)) {
    if (declaration.url) lines.push(`- ${name} (${declaration.tier}): ${declaration.url}`);
    for (const [service, url] of Object.entries(declaration.services ?? {})) {
      lines.push(`- ${name} (${declaration.tier}) ${service}: ${url}`);
    }
  }
  return lines.length > 0 ? lines.join('\n') : undefined;
}

/** Where each environment's testers get in: the profile it names, and never a credential. */
export function renderTestCreds(
  projectId: string,
  document: ProjectDocument | null,
): string | undefined {
  if (!document) return undefined;
  const lines = environmentsOf(document).flatMap(({ name, declaration }) =>
    declaration.testing
      ? [
          `- ${name}: testing profile \`${declaration.testing}\` — its actors and services name \`secret://\` references, never values; read it with \`GET /api/projects/${projectId}/testing-profiles/${declaration.testing}\`.`,
        ]
      : [],
  );
  if (lines.length === 0) return undefined;
  const route = `GET /api/jobs/${SELF_JOB}/testing-profiles/<profile>/secrets`;
  lines.push(
    `- To log in, a ${JUDGING_JOB_TYPES.join(', ')} job reads the values behind its environment's references with \`${route}\` (optionally \`?ref=secret://<scope>/<name>\`, repeated), sending its own credential (\`Authorization: Bearer $FORGE_PAT\`). It answers only the job that credential runs, and only for the profile of the environment deploying the branch its issue's merge mark landed on; every other caller and every other profile is refused by name. Each read is audited, and each value is scrubbed from this job's output. Never write a credential into a comment, a commit or a prompt.`,
  );
  return lines.join('\n');
}

/** What each named testing profile says its environment does NOT have. */
export function renderTestNotes(
  document: ProjectDocument | null,
  profiles: ReadonlyMap<string, TestingProfile>,
): string | undefined {
  if (!document) return undefined;
  const lines: string[] = [];
  for (const { name, declaration } of environmentsOf(document)) {
    const profile = declaration.testing ? profiles.get(declaration.testing) : undefined;
    for (const limit of profile?.limits ?? []) lines.push(`- ${name}: ${limit.note}`);
  }
  return lines.length > 0 ? lines.join('\n') : undefined;
}
