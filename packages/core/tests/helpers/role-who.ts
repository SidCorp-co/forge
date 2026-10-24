import { PERMISSION_ROLE_LABELS } from '@forge/contracts/permissions';

/**
 * A `who` that names a role rather than a person: a project writer or admin, the role a permission's
 * holder reads as (`PERMISSION_ROLE_LABELS`, ISS-605), or nobody. A read that must name a person is
 * held to not matching it.
 */
export const ROLE_WHO = new RegExp(
  `^(A project (writer|admin)|${[...new Set(Object.values(PERMISSION_ROLE_LABELS))].join('|')}|Nobody)$`,
);
