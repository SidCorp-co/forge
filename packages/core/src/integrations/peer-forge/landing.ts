// How a peer Forge project's work lands, read from its project document (ISS-923 fix forward): the
// same `source.type` its mark writer judges a mark by (`landing-evidence.ts:landingMarkRefusal`), and
// for git the branch a landing lands on. The peer may run an older release, so the document is read
// for these few fields alone and a document that does not answer them is refused by name.

/** Where a peer project's work lands, as its merge mark has to name it. */
export type PeerLanding =
  | {
      shape: 'git';
      /** The branch a mark's `target` names. */
      target: string;
      /** Which branch that is: production's `deploysFrom` where a release promotes into it. */
      from: 'defaultBranch' | 'deploysFrom';
    }
  | { shape: 'outside_git' };

export type PeerLandingRead =
  | { ok: true; landing: PeerLanding }
  | {
      ok: false;
      code: 'PEER_FORGE_LANDING_UNDECLARED' | 'PEER_FORGE_LANDING_UNREADABLE';
      detail: string;
    };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const branch = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);

/** Whether a chain of declared promotions carries a change from `from` to `to`. */
function promotes(promotions: unknown, from: string, to: string): boolean {
  const edges = Array.isArray(promotions)
    ? promotions.filter(isRecord).map((p) => ({ from: branch(p.from), to: branch(p.to) }))
    : [];
  const seen = new Set([from]);
  const queue = [from];
  while (queue.length > 0) {
    const at = queue.shift() as string;
    if (at === to) return true;
    for (const e of edges) {
      if (e.from === at && e.to && !seen.has(e.to)) {
        seen.add(e.to);
        queue.push(e.to);
      }
    }
  }
  return false;
}

/** The production environment's `deploysFrom`, where the document declares one. */
function productionDeploysFrom(environments: unknown): string | null {
  if (!isRecord(environments)) return null;
  for (const env of Object.values(environments)) {
    if (isRecord(env) && env.tier === 'production') return branch(env.deploysFrom);
  }
  return null;
}

/**
 * A peer project's landing, from its `GET /api/projects/:id/config` answer. `source.type` `git` lands
 * in git, on `source.git.defaultBranch`, or on production's `deploysFrom` where a declared promotion
 * carries the default branch there (a release-promoted project); `storefront` and `none` land outside
 * git. An undeclared document, an unknown type, or a git source naming no branch is refused.
 */
export function peerLandingOf(answer: unknown): PeerLandingRead {
  if (isRecord(answer) && answer.declared === false) {
    return {
      ok: false,
      code: 'PEER_FORGE_LANDING_UNDECLARED',
      detail:
        'the beta project declares no project document, so whether its work lands in git is unknown and no mark was sent',
    };
  }
  const document = isRecord(answer) && isRecord(answer.document) ? answer.document : null;
  const source = document && isRecord(document.source) ? document.source : null;
  const type = source ? source.type : undefined;
  if (type === 'storefront' || type === 'none')
    return { ok: true, landing: { shape: 'outside_git' } };
  if (type !== 'git') {
    return {
      ok: false,
      code: 'PEER_FORGE_LANDING_UNREADABLE',
      detail: `the beta project document's source.type is ${typeof type === 'string' ? `\`${type}\`` : 'unreadable'}, not git, storefront or none, so no mark was sent`,
    };
  }
  const defaultBranch = isRecord(source?.git) ? branch(source.git.defaultBranch) : null;
  if (!defaultBranch) {
    return {
      ok: false,
      code: 'PEER_FORGE_LANDING_UNREADABLE',
      detail:
        'the beta project lands in git and its document names no source.git.defaultBranch, so the branch a mark names is unknown and no mark was sent',
    };
  }
  const deploysFrom = productionDeploysFrom(document?.environments);
  if (
    deploysFrom &&
    deploysFrom !== defaultBranch &&
    promotes(document?.promotions, defaultBranch, deploysFrom)
  ) {
    return { ok: true, landing: { shape: 'git', target: deploysFrom, from: 'deploysFrom' } };
  }
  return { ok: true, landing: { shape: 'git', target: defaultBranch, from: 'defaultBranch' } };
}
