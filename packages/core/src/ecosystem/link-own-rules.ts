import type { LinkWorld } from './link-rules.js';
import type { LinkWrite } from './link-schema.js';
import type { EcosystemRefusal } from './refusals.js';

export function versionRefusals(doc: LinkWrite, world: LinkWorld, ref: string): EcosystemRefusal[] {
  if (world.versions.has(doc.pinnedVersion)) return [];
  const known = world.versions.size > 0 ? [...world.versions].sort().join(', ') : 'none yet';
  return [
    {
      code: 'VERSION_UNKNOWN',
      path: '/pinnedVersion',
      detail: `${ref} has no recorded version "${doc.pinnedVersion}" (recorded: ${known}); pinnedVersion names a version core has recorded for that contract.`,
    },
  ];
}

// cm:why a module calling its own project's contract is the in-project link and names no ecosystem (Q11, 2026-10-03); naming one for it stays SELF_CONSUMPTION, since an ecosystem is where two projects meet
export function ownLinkRefusals(doc: LinkWrite, world: LinkWorld, ref: string): EcosystemRefusal[] {
  if (doc.ecosystem !== undefined) {
    return [
      {
        code: 'SELF_CONSUMPTION',
        path: '/ecosystem',
        detail: `${ref} is this project's own contract; a module links to it in-project, with no ecosystem, and never through one. Drop ecosystem to write the in-project link.`,
      },
    ];
  }
  if (!world.provider?.interface?.publishes[doc.contract.slug]) {
    return [
      {
        code: 'REF_NOT_PUBLISHED',
        path: '/contract/slug',
        detail: `${ref} is not a contract this project's interface publishes; an in-project link reaches one of the project's own publications, never a module or a guess.`,
      },
    ];
  }
  return versionRefusals(doc, world, ref);
}
