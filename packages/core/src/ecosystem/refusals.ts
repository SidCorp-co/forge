import type { EcosystemRefusalCode } from '@forge/contracts/ecosystem';
import { refuser } from '../lib/refusal.js';
import type { ApiRefusal } from '../project-config/index.js';

export type {
  ChannelRefusalCode,
  EcosystemRefusalCode,
  EcosystemToolRefusalCode,
  LinkRefusalCode,
} from '@forge/contracts/ecosystem';

export const refuseEcosystem = refuser<EcosystemRefusalCode>('ECOSYSTEM_REFUSED');

export interface EcosystemRefusal {
  code: EcosystemRefusalCode | ApiRefusal['code'];
  path: string;
  detail: string;
}

export type Checked<T> = { ok: true; value: T } | { ok: false; refusals: EcosystemRefusal[] };

const CONTRACT_TYPE_PATH = /^\/publishes\/[^/]+\/type$/;

export function renameParseRefusals(refusals: readonly ApiRefusal[]): EcosystemRefusal[] {
  return refusals.map((r) =>
    r.code === 'SCHEMA_VIOLATION' && CONTRACT_TYPE_PATH.test(r.path)
      ? {
          code: 'CONTRACT_TYPE_UNKNOWN',
          path: r.path,
          detail: `${r.detail}; a contract type is one of the closed vocabulary, because it decides which differ measures it.`,
        }
      : r,
  );
}

export function renameDocumentParseRefusals(refusals: readonly ApiRefusal[]): EcosystemRefusal[] {
  return refusals.map((r) =>
    r.code === 'SCHEMA_VIOLATION' && r.path === '/type'
      ? {
          code: 'DOCUMENT_TYPE_UNKNOWN',
          path: r.path,
          detail: `${r.detail}; the channel carries five types of document and nothing else, so there is no free message.`,
        }
      : r,
  );
}

export function renameHoldParseRefusals(refusals: readonly ApiRefusal[]): EcosystemRefusal[] {
  return refusals.map((r) =>
    r.code === 'SCHEMA_VIOLATION' && r.path === '/reason'
      ? {
          code: 'HOLD_WITHOUT_REASON',
          path: r.path,
          detail: 'a hold says why, in 1 to 1000 characters, and both sides read it.',
        }
      : r,
  );
}
