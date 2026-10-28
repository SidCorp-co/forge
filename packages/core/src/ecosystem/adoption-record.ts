/**
 * The adoption record a consumer issue lands on when its whole deliverable is adopting a contract
 * version (REQ-5 BC-17): the project's interface built against that version, and every link it
 * holds to the contract pinned there. Read here, from the rows, never from the caller's word: the
 * mark writer reads it before stamping, and the close reads it again, so a mark whose links have
 * since moved does not close as adopted (REQ-5 BC-18).
 */

import {
  type AdoptionHeld,
  type AdoptionReading,
  LANDED_CONTRACT,
} from '@forge/contracts/ecosystem';
import { db, type Tx } from '../db/client.js';
import { versionsOf } from './contract/store.js';
import { heldInterface } from './interface-service.js';
import { readInterface } from './interface-store.js';
import { linksWhere } from './link-store.js';
import { projectsWhere } from './store.js';

interface ProviderFacts {
  recorded: ReadonlySet<string>;
}

/** What one named adoption reads as, given the rows: pure, so each shortfall is named once. */
export function adoptionShortfall(args: {
  ref: string;
  provider: ProviderFacts | null;
  builtAgainst: readonly string[];
  interfaceRevision: number | null;
  pins: readonly { modulePath: string; pinnedVersion: string }[];
}): string | null {
  const m = LANDED_CONTRACT.exec(args.ref);
  if (!m) return `${args.ref} is not written as <project>/<contract>@<version>`;
  const [, project, contract, version] = m;
  const named = `${project}/${contract}`;
  if (!args.provider)
    return `${args.ref} names project ${project}, which no project holds as its slug`;
  if (!args.provider.recorded.has(version as string)) {
    return `${args.ref} names a version ${named} never recorded`;
  }
  if (args.interfaceRevision === null) {
    return `this project declares no interface, so nothing records that it consumes ${named}`;
  }
  if (args.builtAgainst.length === 0) {
    return `this project's interface (revision ${args.interfaceRevision}) does not consume ${named}`;
  }
  const off = args.builtAgainst.filter((v) => v !== version);
  if (off.length > 0) {
    return `this project's interface (revision ${args.interfaceRevision}) consumes ${named} built against ${off.join(', ')}, not ${version}`;
  }
  const behind = args.pins.filter((p) => p.pinnedVersion !== version);
  if (behind.length > 0) {
    const shown = behind
      .slice(0, 5)
      .map((p) => `${p.modulePath} at ${p.pinnedVersion}`)
      .join(', ');
    const more = behind.length > 5 ? ` and ${behind.length - 5} more` : '';
    return `${behind.length} of this project's links to ${named} ${behind.length === 1 ? 'is' : 'are'} not pinned at ${version} (${shown}${more})`;
  }
  return null;
}

/** Reads each named adoption off the project's interface and links; the first that does not hold
 *  is refused by name with what was read. */
export async function readAdoptionRecord(
  projectId: string,
  refs: readonly string[],
  tx: Tx = db,
): Promise<AdoptionReading> {
  const stored = await readInterface(tx, projectId);
  const doc = stored ? heldInterface(stored, projectId).document : null;
  const links = await linksWhere(tx, { consumerId: projectId });
  const held: AdoptionHeld[] = [];
  for (const ref of refs) {
    const m = LANDED_CONTRACT.exec(ref);
    const project = m?.[1] ?? '';
    const contract = m?.[2] ?? '';
    const [provider] = m ? await projectsWhere(tx, { slugs: [project] }) : [];
    const versions = provider ? await versionsOf(tx, [provider.id], contract) : [];
    const pins = provider
      ? links.filter((l) => l.providerProjectId === provider.id && l.contractSlug === contract)
      : [];
    const builtAgainst = (doc?.consumes ?? [])
      .filter((c) => c.contract === `${project}/${contract}`)
      .map((c) => c.builtAgainst);
    const short = adoptionShortfall({
      ref,
      provider: provider ? { recorded: new Set(versions.map((v) => v.version)) } : null,
      builtAgainst,
      interfaceRevision: stored?.revision ?? null,
      pins,
    });
    if (short) {
      return {
        ok: false,
        code: 'ADOPTION_NOT_RECORDED',
        ref,
        detail: `${short}, so it is not an adoption record this issue can land on.`,
      };
    }
    held.push({ ref, interfaceRevision: stored?.revision ?? 0, links: pins.length });
  }
  return { ok: true, held };
}
