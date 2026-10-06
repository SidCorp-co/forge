import type { EcosystemRefusal } from './refusals.js';

/** A contract's recorded versions, each with its approval: proposed, approved or returned. */
export type VersionApprovals = ReadonlyMap<string, string>;

const listed = (versions: readonly string[]) =>
  versions.length > 0 ? [...versions].sort().join(', ') : 'none yet';

/**
 * The version a consumer pins (a link's pinnedVersion, a consumption's builtAgainst): one core has
 * recorded and a holder of contracts.approve has approved. Consumers and the provider build against
 * the same approved version, never a proposed or returned one (requirement-to-delivery `publish`).
 */
export function pinRefusals(input: {
  ref: string;
  version: string;
  versions: VersionApprovals | undefined;
  path: string;
  field: string;
}): EcosystemRefusal[] {
  const { ref, version, versions, path, field } = input;
  const approval = versions?.get(version);
  if (approval === 'approved') return [];
  if (approval === undefined) {
    return [
      {
        code: 'VERSION_UNKNOWN',
        path,
        detail: `${ref} has no recorded version "${version}" (recorded: ${listed([...(versions?.keys() ?? [])])}); ${field} names a version core has recorded for that contract.`,
      },
    ];
  }
  const approved = [...(versions?.entries() ?? [])].filter(([, a]) => a === 'approved');
  return [
    {
      code: 'CONTRACT_VERSION_NOT_APPROVED',
      path,
      detail: `${ref} version "${version}" is ${approval}, not approved (approved: ${listed(approved.map(([v]) => v))}); ${field} names an approved version, since consumers build against an approved version, never a proposed or returned one.`,
    },
  ];
}
