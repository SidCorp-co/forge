// The verdict door's one refusal that reads the project's release declaration: a `runtime` identity
// where nothing runs that Forge observes.

import { unobservedBuildOf } from '../ports.js';
import type { VerdictRefusal } from './verdict-input.js';

/**
 * A `runtime` identity on a project that declares no production environment and names no testing
 * environment (`delivery.judgedOn`, REQ-36 BC-18; coordinator ruling 2026-10-26): nothing runs
 * there that Forge observes, so the verdict could never count
 * (`@forge/contracts/verdict-identity:landedIdentityWhy`), and keeping it was a silent accept. It
 * is refused naming the commit verdict that does count, at the build `judged-build` names.
 */
export async function unobservedRuntimeFault(
  issue: { id: string; projectId: string },
  criterion: number,
  ref: string,
): Promise<VerdictRefusal | null> {
  const build = await unobservedBuildOf(issue);
  if (!build) return null;
  const at = build.sha
    ? `\`{ kind: 'commit', sha: '${build.sha}' }\`, the build \`GET /api/issues/:id/judged-build\` names`
    : `\`{ kind: 'commit', sha }\` at the build \`GET /api/issues/:id/judged-build\` names once there is one (${build.basis})`;
  return {
    code: 'VERDICT_RUNTIME_UNOBSERVED',
    criterion,
    detail: `criterion ${criterion} names identity runtime \`${ref}\`, and this project declares no production environment and names no testing environment: nothing runs there that Forge observes, so a runtime verdict never counts. Judge it at its landing and send a commit verdict there: identity ${at}; or, where its releases are judged on a deployed environment, name that environment in the project document's \`delivery.judgedOn\` (REQ-36 BC-18)`,
  };
}
