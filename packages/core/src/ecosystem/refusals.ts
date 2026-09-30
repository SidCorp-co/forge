import type { ApiRefusal } from '../project-config/documents.js';

export type EcosystemRefusalCode =
  | 'STALE_BASE'
  | 'ECOSYSTEM_ID_IMMUTABLE'
  | 'ECOSYSTEM_SLUG_TAKEN'
  | 'CHANNEL_CODE_TAKEN'
  | 'CHANNEL_CODE_IN_USE'
  | 'RESPONSE_WINDOW_EXCEEDS_ECOSYSTEM'
  | 'PROJECT_ID_IMMUTABLE'
  | 'CONTRACT_TYPE_UNKNOWN'
  | 'ARTIFACT_FOR_OPAQUE'
  | 'ARTIFACT_MISSING'
  | 'REF_UNRESOLVED'
  | 'REF_NOT_PUBLISHED'
  | 'ECOSYSTEM_NOT_SHARED'
  | 'ECOSYSTEM_NOT_MEMBER'
  | 'SELF_CONSUMPTION'
  | 'VERSION_UNKNOWN'
  | 'CONSUMPTION_DUPLICATE'
  | 'CONTRACT_IN_USE'
  | 'MEMBERSHIP_EXISTS'
  | 'MEMBERSHIP_TRANSITION_NOT_ALLOWED'
  | 'MEMBERSHIP_REASON_REQUIRED'
  | 'MEMBERSHIP_IN_USE';

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
