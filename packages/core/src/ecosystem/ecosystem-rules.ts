import { pointer } from '../project-config/documents.js';
import type { EcosystemRefusal } from './refusals.js';
import type { EcosystemDocument } from './schema.js';

export interface MemberCommitment {
  projectSlug: string;
  responseDays: { rfi: number; 'change-request': number };
}

export interface EcosystemWorld {
  current: EcosystemDocument | null;
  slugHeldBy: string | null;
  codeHeldBy: string | null;
  numbersReserved: boolean;
  memberCommitments: readonly MemberCommitment[];
}

export function checkEcosystem(doc: EcosystemDocument, world: EcosystemWorld): EcosystemRefusal[] {
  const out: EcosystemRefusal[] = [];
  if (world.slugHeldBy) {
    out.push({
      code: 'ECOSYSTEM_SLUG_TAKEN',
      path: '/ecosystem/slug',
      detail: `slug "${doc.ecosystem.slug}" is already ecosystem ${world.slugHeldBy}'s; an ecosystem slug is unique across the deployment.`,
    });
  }
  if (world.codeHeldBy) {
    out.push({
      code: 'CHANNEL_CODE_TAKEN',
      path: '/channel/code',
      detail: `channel code "${doc.channel.code}" is already ecosystem ${world.codeHeldBy}'s; a document number such as ${doc.channel.code}-CN-1 must name one channel.`,
    });
  }
  const before = world.current?.channel.code;
  if (before !== undefined && before !== doc.channel.code && world.numbersReserved) {
    out.push({
      code: 'CHANNEL_CODE_IN_USE',
      path: '/channel/code',
      detail: `channel code "${before}" already prefixes a reserved document number, and a number is never reissued; the code stays "${before}".`,
    });
  }
  for (const kind of ['rfi', 'change-request'] as const) {
    const allowed = doc.channel.responseDays[kind];
    const over = world.memberCommitments
      .filter((m) => m.responseDays[kind] > allowed)
      .map((m) => `${m.projectSlug} (${m.responseDays[kind]})`);
    if (over.length > 0) {
      out.push({
        code: 'RESPONSE_WINDOW_EXCEEDS_ECOSYSTEM',
        path: pointer(['channel', 'responseDays', kind]),
        detail: `${allowed} day(s) for a ${kind} is shorter than what active members already promise: ${over.join(', ')}; they shorten their commitments first.`,
      });
    }
  }
  return out;
}
