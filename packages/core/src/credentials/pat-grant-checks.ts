import type { PatRefusalCode } from '@forge/contracts/pat';
import { HTTPException } from 'hono/http-exception';
import { loadVisibleProjectIds } from '../lib/authz.js';
import { env } from '../lib/env.js';
import { refuser } from '../lib/refusal.js';
import { countActivePatsForUser, lastFreshAuthAt } from './pat.js';
import {
  PAT_ACCOUNT_ONLY_PERMISSIONS,
  PAT_EXPLICIT_PERMISSIONS,
  PAT_FULL_NARROWING_PERMISSIONS,
  PAT_PERMISSION_ALL,
  PAT_PERMISSION_NAMES,
  patGrantIsStated,
  type StatedPatGrant,
} from './pat-permissions.js';

/**
 * The checks a person's choice of reach answers before a token is minted for it, at both places a
 * person chooses one: the token form (`POST /api/pat`) and an MCP client's consent page
 * (`POST /api/mcp-auth/authorize`). One rule set, so the two cannot drift apart.
 */

export const refusePat = refuser<PatRefusalCode>('PAT_REFUSED');

/** The permission menu a person picks a token's reach from. */
export function patMenu() {
  return {
    permissions: [...PAT_PERMISSION_NAMES],
    accountOnly: [...PAT_ACCOUNT_ONLY_PERMISSIONS],
    explicit: [...PAT_EXPLICIT_PERMISSIONS],
    full: PAT_PERMISSION_ALL,
  };
}

/**
 * The grant as stated, or a refusal naming what is wrong with it: nothing named, full access beside
 * what it already holds, or an account permission on a token fenced to projects.
 */
export function mintableGrant(
  permissions: readonly string[] | null | undefined,
  fenced: boolean,
): StatedPatGrant {
  if (!patGrantIsStated(permissions)) {
    throw new HTTPException(400, {
      message:
        'a token states what it may reach: send `permissions` naming the groups this token ' +
        `needs, or ["${PAT_PERMISSION_ALL}"] for full access chosen on purpose. An omitted ` +
        'grant used to mint a token reaching the whole menu, and no longer does.',
      cause: {
        code: 'PAT_PERMISSIONS_REQUIRED',
        details: { menu: PAT_PERMISSION_NAMES, full: [PAT_PERMISSION_ALL] },
      },
    });
  }
  const besideFull = permissions.filter(
    (p) => p !== PAT_PERMISSION_ALL && !PAT_FULL_NARROWING_PERMISSIONS.includes(p),
  );
  if (permissions.includes(PAT_PERMISSION_ALL) && besideFull.length > 0) {
    throw new HTTPException(400, {
      message:
        `full access already holds ${besideFull.join(', ')}: "${PAT_PERMISSION_ALL}" holds ` +
        `everything your role can do, approvals included. Send ["${PAT_PERMISSION_ALL}"] alone ` +
        `(only ${PAT_FULL_NARROWING_PERMISSIONS.join(', ')}, which narrows it, may join it), or ` +
        'name what this token needs without it.',
      cause: {
        code: 'PAT_PERMISSIONS_FULL_NOT_COMBINABLE',
        details: { sent: permissions, alreadyHeld: besideFull },
      },
    });
  }
  const accountOnly = permissions.filter((p) =>
    (PAT_ACCOUNT_ONLY_PERMISSIONS as readonly string[]).includes(p),
  );
  if (fenced && accountOnly.length > 0) {
    throw refusePat(
      'PAT_ACCOUNT_PERMISSION_ON_SCOPED_TOKEN',
      `${accountOnly.join(', ')} ${accountOnly.length === 1 ? 'is' : 'are'} account ` +
        'permissions, whose routes resolve no project, and this token is fenced to projects. ' +
        'Drop them, or mint the token with no project list.',
      '/permissions',
    );
  }
  return permissions;
}

/** Refuses a person already holding as many live tokens as one may. */
export async function assertUnderTokenLimit(userId: string): Promise<void> {
  const active = await countActivePatsForUser(userId);
  if (active >= env.PAT_MAX_PER_USER) {
    throw refusePat(
      'PAT_LIMIT',
      `you hold the most live personal access tokens allowed (${env.PAT_MAX_PER_USER}); revoke one first`,
    );
  }
}

/** Refuses a project the person cannot see, naming it. */
export async function assertProjectsVisible(
  userId: string,
  projectIds: readonly string[],
): Promise<void> {
  if (projectIds.length === 0) return;
  const allowed = new Set(await loadVisibleProjectIds(userId));
  const projectId = projectIds.find((pid) => !allowed.has(pid));
  if (projectId) {
    throw new HTTPException(403, {
      message: 'project not accessible',
      cause: { code: 'FORBIDDEN_PROJECT', details: { projectId } },
    });
  }
}

/** Refuses a person who has not proved their password or provider within `minutes`. */
export async function assertFreshAuth(userId: string, minutes = 5): Promise<void> {
  const at = await lastFreshAuthAt(userId);
  if (!at || Date.now() - at.getTime() > minutes * 60_000) {
    throw new HTTPException(403, {
      message: 'fresh authentication required',
      cause: { code: 'FRESH_AUTH_REQUIRED' },
    });
  }
}
