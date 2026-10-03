import type { ContractWaitRefusalCode } from '@forge/contracts/contract-waits';
import type { ApiRefusal } from '../project-config/documents.js';
import type { ApprovalRefusalCode } from './contract/approval.js';
import type { ContractRefusalCode } from './contract/refusal-codes.js';

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
  | 'CONSUMPTION_ECOSYSTEM_MISSING'
  | 'VERSION_UNKNOWN'
  | 'CONSUMPTION_DUPLICATE'
  | 'CONTRACT_IN_USE'
  | 'MEMBERSHIP_EXISTS'
  | 'MEMBERSHIP_TRANSITION_NOT_ALLOWED'
  | 'MEMBERSHIP_REASON_REQUIRED'
  | 'MEMBERSHIP_IN_USE'
  | 'INTERFACE_WRITER_NOT_PROJECT'
  | 'COMMITMENTS_SET_BY_PERSON'
  | ChannelRefusalCode
  | EcosystemToolRefusalCode
  | ContractRefusalCode
  | ApprovalRefusalCode
  | ContractWaitRefusalCode
  | LinkRefusalCode;

export type LinkRefusalCode =
  | 'LINK_WRITER_NOT_CONSUMER'
  | 'LINK_STATE_UNKNOWN'
  | 'LINK_GUIDE_WITHOUT_CALL_SITE'
  | 'LINK_DUPLICATE'
  | 'LINK_CONSUMER_NOT_MEMBER'
  | 'LINK_PROVIDER_NOT_MEMBER'
  | 'LINK_ECOSYSTEM_MISSING'
  | 'LINK_IDENTITY_IMMUTABLE'
  | 'PATH_OUTSIDE_REPO'
  | 'CALL_SITE_KIND_MISMATCH'
  | 'ARTEFACT_KIND_UNKNOWN'
  | 'BUILDER_RUN_WRITER_NOT_PROJECT'
  | 'BUILDER_RUN_NOT_MEMBER'
  | 'BUILDER_RUN_LINK_UNKNOWN'
  | 'BUILDER_RUN_IMMUTABLE'
  | 'BUILDER_RUN_ALREADY_OPEN'
  | 'BUILDER_RUN_HEAD_UNREADABLE'
  | 'BUILDER_RUN_NOT_OPEN'
  | 'BUILDER_RUN_SUPERSEDED'
  | 'BUILDER_RUN_SUPERSEDE_NOT_AUTHORISED'
  | 'BUILDER_RUN_SUPERSEDE_WITHOUT_REASON'
  | 'BUILDER_TRIGGER_UNKNOWN'
  | 'STEP_STATUS_UNKNOWN'
  | 'FINDING_CLASSIFICATION_UNKNOWN';

export type ChannelRefusalCode =
  | 'DOCUMENT_TYPE_UNKNOWN'
  | 'DOCUMENT_TYPE_IMMUTABLE'
  | 'DOCUMENT_STATE_NOT_ALLOWED'
  | 'MEMBERSHIP_NOT_ACTIVE'
  | 'RECIPIENT_NOT_COUNTERPARTY'
  | 'RECIPIENTS_NOT_DERIVED'
  | 'NUMBER_NOT_IN_CHANNEL'
  | 'NUMBER_TYPE_MISMATCH'
  | 'PUBLISHED_WITHOUT_GATE'
  | 'GATE_MODE_MISMATCH'
  | 'GATE_RETURN_WITHOUT_NOTE'
  | 'REPLY_WITHOUT_PARENT'
  | 'REPLY_TO_ENDED'
  | 'REPLY_TYPE_NOT_ALLOWED'
  | 'REPLY_FROM_NON_RECIPIENT'
  | 'DISPOSITION_NOT_FOR_TYPE'
  | 'ADAPT_AFTER_SUNSET'
  | 'CONTRACT_NOT_SENDERS'
  | 'CLASSIFICATION_BELOW_MEASURED'
  | 'MEASURED_CHANGE_OMITTED'
  | 'EFFECTIVE_BEFORE_DUE'
  | 'SUNSET_BEFORE_NOTICE_PERIOD'
  | 'DEADLINE_BEFORE_REACHABLE'
  | 'DUE_BY_TOO_SOON'
  | 'CONTENT_CODE'
  | 'CONTENT_INTERNAL_REF'
  | 'CONTENT_SECRET'
  | 'CONTENT_PRESCRIBES_IMPLEMENTATION'
  | 'THREAD_HELD'
  | 'THREAD_ALREADY_HELD'
  | 'THREAD_NOT_HELD'
  | 'HOLD_NOT_AUTHORISED'
  | 'HOLD_WITHOUT_REASON'
  | 'WITHDRAW_WITHOUT_REASON'
  | 'SUPERSEDE_WITHOUT_REASON'
  | 'SUPERSEDE_NOT_A_REPLACEMENT'
  | 'CHANNEL_NO_ROLE'
  | 'CHANNEL_WRITE_NOT_AUTHORISED'
  | 'CHANNEL_NOT_A_PARTY'
  | 'CHANNEL_TURN_UNBOUND'
  | 'CHANNEL_ARGUMENT_INVALID'
  | 'CHANNEL_ECOSYSTEM_AMBIGUOUS'
  | 'CHANNEL_PROJECT_UNNAMED'
  | 'CHANNEL_PROJECT_OUTSIDE_TOKEN';

/** What `forge_ecosystem` refuses before a service is asked; everything after is the service's own code. */
export type EcosystemToolRefusalCode =
  | 'ECOSYSTEM_ARGUMENT_INVALID'
  | 'ECOSYSTEM_TURN_UNBOUND'
  | 'ECOSYSTEM_PROJECT_UNNAMED'
  | 'ECOSYSTEM_PROJECT_OUTSIDE_TOKEN'
  | 'ECOSYSTEM_WRITE_NOT_AUTHORISED'
  | 'ECOSYSTEM_NOT_AUTHORISED'
  | 'ECOSYSTEM_RECORD_NOT_FOUND';

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
