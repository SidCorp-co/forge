/** The commit a joined or manually opened builder run reads: from the project's host, or a runner's bound checkout where no host is bound (ISS-50). */

import { resolveSourceHost, SourceHostUnavailable } from '../integrations/source-host/index.js';
import { parseRepository, readDeclaredSource } from '../project-config/index.js';
import { CheckoutHeadUnreadable, readCheckoutHead } from '../runners/index.js';
import type { BuilderSource } from './link-rules.js';
import type { BuilderRunWrite } from './link-schema.js';
import type { Checked } from './refusals.js';

const COMMIT = /^[0-9a-f]{40}$/;

/** A default-branch head with where and when it was read: evidence carried on the run, never a stored fact. */
export interface HeadReading {
  sha: string;
  ref: string;
  readAt: string;
  via: 'source-host' | 'runner-checkout';
}

/** The read could not be made; the message says why and what would make it. */
class HeadUnreadable extends Error {}

// The one door a head is read through, held as an object so an integration world can stand a host in for it. A hosted repository is read through its source host binding; with none, or for a local path no host serves, a runner's bound checkout reads it with its own git access (ADR 0009). A binding that exists and cannot serve stays its own refusal: the checkout never papers over it.
export const projectHead = {
  async read(projectId: string): Promise<HeadReading> {
    const { repository, defaultBranch } = await readDeclaredSource(projectId);
    if (!repository || !defaultBranch) {
      throw new HeadUnreadable(
        'the project document declares no git repository and default branch (source.type git, source.git.repository, source.git.defaultBranch); declare them with PUT /api/projects/:id/config',
      );
    }
    const ref = `refs/heads/${defaultBranch}`;
    let unbound: string;
    if (parseRepository(repository).kind === 'local') {
      unbound = `the repository is the local path ${repository}, which no source host serves`;
    } else {
      try {
        const host = await resolveSourceHost(projectId);
        const sha = await host.branchHead(defaultBranch);
        return { sha, ref, readAt: new Date().toISOString(), via: 'source-host' };
      } catch (err) {
        if (!(err instanceof SourceHostUnavailable) || err.reason !== 'no_binding') throw err;
        unbound = err.message;
      }
    }
    try {
      const head = await readCheckoutHead(projectId, defaultBranch);
      return { sha: head.sha, ref: head.ref, readAt: head.readAt, via: head.via };
    } catch (err) {
      if (!(err instanceof CheckoutHeadUnreadable)) throw err;
      throw new HeadUnreadable(`${unbound}, and ${err.message}`);
    }
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
  read?: (projectId: string) => Promise<HeadReading>;
}): Promise<Checked<BuilderRunWrite['trigger']>> {
  const { projectId, kind, source } = input;
  if (source.type === 'storefront') {
    return { ok: true, value: { kind, sha: null, source: 'storefront' } };
  }
  const read = input.read ?? ((id: string) => projectHead.read(id));
  let head: HeadReading;
  try {
    head = await read(projectId);
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    return unreadable(projectId, kind, why, err instanceof HeadUnreadable);
  }
  if (!COMMIT.test(head.sha)) {
    return unreadable(
      projectId,
      kind,
      `the ${head.via} read answered ${JSON.stringify(head.sha)}, not a 40-hex commit`,
      false,
    );
  }
  return {
    ok: true,
    value: { kind, sha: head.sha, head: { ref: head.ref, readAt: head.readAt, via: head.via } },
  };
}

function unreadable(
  projectId: string,
  kind: string,
  why: string,
  waysOutSaid: boolean,
): Checked<BuilderRunWrite['trigger']> {
  return {
    ok: false,
    refusals: [
      {
        code: 'BUILDER_RUN_HEAD_UNREADABLE',
        path: '/trigger/sha',
        detail: `a ${kind} builder run of project ${projectId} reads its default branch's head, and it could not be read: ${why}. Nothing was opened${waysOutSaid ? '' : "; bind the repository's host on the project's Integrations page, or bring online a box holding a bound checkout of it (`forge-runner bind`), and try again"}.`,
      },
    ],
  };
}
