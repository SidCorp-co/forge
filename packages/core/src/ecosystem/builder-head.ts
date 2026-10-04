/** The commit a joined or manually opened builder run reads, taken from the project's own host (ISS-50). */

import { resolveSourceHost } from '../integrations/source-host/index.js';
import { readDeclaredSource } from '../project-config/index.js';
import type { BuilderSource } from './link-rules.js';
import type { BuilderRunWrite } from './link-schema.js';
import type { Checked } from './refusals.js';

const COMMIT = /^[0-9a-f]{40}$/;

// cm:why the one door a head is read through, held as an object so an integration world can stand a host in for it; the default reads the declared default branch through the project's SourceHost
export const projectHead = {
  async read(projectId: string): Promise<string> {
    const { repository, defaultBranch } = await readDeclaredSource(projectId);
    if (!repository || !defaultBranch) {
      throw new Error(
        'the project document declares no git repository and default branch (source.type git, source.git.repository, source.git.defaultBranch)',
      );
    }
    const host = await resolveSourceHost(projectId);
    return host.branchHead(defaultBranch);
  },
};

/**
 * The trigger a run opened now owes: a storefront project names no commit, and a repository project
 * names its default branch's head as its host reports it. A head that cannot be read refuses the
 * opening by name; no stand-in sha is ever stored.
 */
export async function owedTrigger(input: {
  projectId: string;
  kind: BuilderRunWrite['trigger']['kind'];
  source: BuilderSource;
  read?: (projectId: string) => Promise<string>;
}): Promise<Checked<BuilderRunWrite['trigger']>> {
  const { projectId, kind, source } = input;
  if (source.type === 'storefront') {
    return { ok: true, value: { kind, sha: null, source: 'storefront' } };
  }
  const read = input.read ?? ((id: string) => projectHead.read(id));
  let head: string;
  try {
    head = await read(projectId);
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    return unreadable(projectId, kind, why);
  }
  if (!COMMIT.test(head)) {
    return unreadable(
      projectId,
      kind,
      `the host answered ${JSON.stringify(head)}, not a 40-hex commit`,
    );
  }
  return { ok: true, value: { kind, sha: head } };
}

function unreadable(
  projectId: string,
  kind: string,
  why: string,
): Checked<BuilderRunWrite['trigger']> {
  return {
    ok: false,
    refusals: [
      {
        code: 'BUILDER_RUN_HEAD_UNREADABLE',
        path: '/trigger/sha',
        detail: `a ${kind} builder run of project ${projectId} reads its default branch's head, and it could not be read: ${why}. Nothing was opened; bind the repository's host (or declare source.git) and try again.`,
      },
    ],
  };
}
