import type { PatFence, PatFenceRefusalCode } from '@forge/contracts/pat-fence';
import { coreTokenNamePrefixOf } from '../credentials/pat-format.js';
import { PAT_ACCOUNT_ONLY_PERMISSIONS } from '../credentials/pat-permissions.js';
import type { Refusal } from '../lib/refusal.js';

export type PatFenceRefusal = Refusal & { code: PatFenceRefusalCode };

export type FencedToken = {
  id: string;
  name: string;
  deviceId: string | null;
  revokedAt: Date | null;
  expiresAt: Date | null;
  permissions: readonly string[] | null;
  projectIds: readonly string[] | null;
  boundProjectId: string | null;
};

const refusal = (code: PatFenceRefusalCode, path: string, detail: string): PatFenceRefusal => ({
  code,
  path,
  detail,
});

export function fenceEditorRefusal(principal: string | undefined): PatFenceRefusal | null {
  if (principal === 'user') return null;
  return refusal(
    'PAT_FENCE_BY_TOKEN_FORBIDDEN',
    '',
    `a token's project fence is changed by its owner signed in with a session; this request arrived on ${principal ?? 'no credential'}, and a credential that could edit a fence could widen its own reach`,
  );
}

export function tokenStateRefusals(token: FencedToken, now: Date): PatFenceRefusal[] {
  if (token.revokedAt) {
    return [
      refusal(
        'PAT_FENCE_TOKEN_REVOKED',
        '',
        `token ${token.name} was revoked at ${token.revokedAt.toISOString()} and reaches nothing; mint a new token with the fence you want`,
      ),
    ];
  }
  if (token.expiresAt && token.expiresAt.getTime() <= now.getTime()) {
    return [
      refusal(
        'PAT_FENCE_TOKEN_EXPIRED',
        '',
        `token ${token.name} expired at ${token.expiresAt.toISOString()} and reaches nothing; rotate it with a new expiry first, or mint a new token`,
      ),
    ];
  }
  const reserved = coreTokenNamePrefixOf(token.name);
  if (token.deviceId !== null || reserved !== null) {
    return [
      refusal(
        'PAT_FENCE_CORE_MINTED',
        '',
        `token ${token.name} is one core mints for ${token.deviceId !== null ? 'a paired box' : `"${reserved}" credentials`}, and core decides its fence; only a personal token you minted takes a fence edit`,
      ),
    ];
  }
  return [];
}

export function fenceOf(body: {
  projectIds?: readonly string[] | undefined;
  boundProjectId?: string | undefined;
}): PatFence {
  if (body.boundProjectId !== undefined) {
    return { projectIds: null, boundProjectId: body.boundProjectId };
  }
  return { projectIds: [...(body.projectIds ?? [])], boundProjectId: null };
}

function sameFence(a: PatFence, b: PatFence): boolean {
  if (a.boundProjectId !== b.boundProjectId) return false;
  const left = [...(a.projectIds ?? [])].sort();
  const right = [...(b.projectIds ?? [])].sort();
  if ((a.projectIds === null) !== (b.projectIds === null)) return false;
  return left.length === right.length && left.every((id, i) => id === right[i]);
}

export function fenceRefusals(
  token: FencedToken,
  next: PatFence,
  reachable: ReadonlySet<string>,
): PatFenceRefusal[] {
  const out: PatFenceRefusal[] = [];
  const named =
    next.boundProjectId !== null
      ? [{ id: next.boundProjectId, path: '/boundProjectId' }]
      : (next.projectIds ?? []).map((id, i) => ({ id, path: `/projectIds/${i}` }));
  for (const { id, path } of named) {
    if (reachable.has(id)) continue;
    out.push(
      refusal(
        'PAT_FENCE_PROJECT_NOT_REACHABLE',
        path,
        `project ${id} is not one you reach (a member of it, or an owner or admin of its organization), so no token of yours may be fenced to it`,
      ),
    );
  }
  const accountOnly = (token.permissions ?? []).filter((p) =>
    (PAT_ACCOUNT_ONLY_PERMISSIONS as readonly string[]).includes(p),
  );
  if (accountOnly.length > 0) {
    out.push(
      refusal(
        'PAT_FENCE_ACCOUNT_PERMISSION',
        '',
        `token ${token.name} holds ${accountOnly.join(', ')}, account permissions whose routes resolve no project, so it cannot be fenced to projects; mint a fenced token without them`,
      ),
    );
  }
  const current = {
    projectIds: token.projectIds ? [...token.projectIds] : null,
    boundProjectId: token.boundProjectId,
  };
  if (out.length === 0 && sameFence(current, next)) {
    out.push(
      refusal(
        'PAT_FENCE_UNCHANGED',
        '',
        `token ${token.name} is already fenced to exactly this; nothing to change`,
      ),
    );
  }
  return out;
}
