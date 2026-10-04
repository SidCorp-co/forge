/**
 * The guards of a mockup (MK-n, ISS-78) as pure functions over what the service read: what a
 * proposal may carry, which target it may be about, and who may accept, return or withdraw it.
 * Each refusal is named; nothing is written.
 */

import {
  MOCKUP_KIND_MIMES,
  MOCKUP_LIMITS,
  type MockupKind,
  type MockupRefusalCode,
  type MockupStatus,
  mockupKindTakes,
  type ProposeMockupRequest,
} from '@forge/contracts/mockups';
import type { RevisionState } from '@forge/contracts/requirements';
import { type PersonActFacts, personActRefusal } from '../lib/person-act.js';

export interface MockupRefusal {
  code: MockupRefusalCode;
  path: string;
  detail: string;
}

const refusal = (code: MockupRefusalCode, path: string, detail: string): MockupRefusal => ({
  code,
  path,
  detail,
});

/** Exactly one of bytes, a wireframe document or an upload already in the project. */
export function contentRefusal(input: ProposeMockupRequest): MockupRefusal | null {
  const has =
    (input.contentBase64 ? 1 : 0) + (input.document !== undefined ? 1 : 0) + (input.source ? 1 : 0);
  if (has !== 1) {
    return refusal(
      'MOCKUP_CONTENT_REQUIRED',
      '',
      `a mockup carries exactly one of contentBase64 (its bytes), document (a wireframe-v1 board) or source (an upload already in this project); this body has ${has === 0 ? 'none' : has}.`,
    );
  }
  if (input.document !== undefined && input.kind !== 'wireframe') {
    return refusal(
      'MOCKUP_CONTENT_REQUIRED',
      '/document',
      `document carries a wireframe-v1 board, so its kind is wireframe, not ${input.kind}.`,
    );
  }
  if (input.contentBase64 && !input.name) {
    return refusal('MOCKUP_CONTENT_REQUIRED', '/name', 'a mockup sent as bytes names its file.');
  }
  return null;
}

export function typeRefusal(kind: MockupKind, mime: string, why?: string): MockupRefusal | null {
  if (!why && mockupKindTakes(kind, mime)) return null;
  return refusal(
    'MOCKUP_TYPE_INVALID',
    '/mime',
    `${why ?? `${mime || 'this type'} is not a ${kind} mockup`}; a ${kind} mockup is ${MOCKUP_KIND_MIMES[kind].join(' or ')}.`,
  );
}

export function sizeRefusal(kind: MockupKind, size: number): MockupRefusal | null {
  if (size === 0) {
    return refusal('MOCKUP_TYPE_INVALID', '/contentBase64', 'the mockup decodes to no bytes.');
  }
  const most = MOCKUP_LIMITS.bytes[kind];
  if (size <= most) return null;
  return refusal(
    'MOCKUP_TOO_LARGE',
    '/contentBase64',
    `the ${kind} mockup is ${size} bytes; a ${kind} mockup holds at most ${most}.`,
  );
}

// cm:guard a requirement mockup is proposed against a revision that can still be agreed: a
// superseded revision is evidence and takes nothing (MOCKUP_REVISION_SUPERSEDED); a current one
// takes it as an explicitly additive proposal, pinned only by a baseline a person writes after
// accepting it, so nothing under an agreed baseline changes silently
export function revisionRefusal(
  key: string,
  revision: number,
  state: RevisionState | null,
  head: number | null,
): MockupRefusal | null {
  if (state === null) {
    return refusal(
      'MOCKUP_TARGET_INVALID',
      '/target/revision',
      `${key} has no revision ${revision}.`,
    );
  }
  if (state !== 'superseded') return null;
  return refusal(
    'MOCKUP_REVISION_SUPERSEDED',
    '/target/revision',
    `${key} revision ${revision} is superseded${head === null ? '' : ` by revision ${head}`}; propose the mockup against revision ${head ?? revision} instead.`,
  );
}

export function queueRefusal(target: string, open: number): MockupRefusal | null {
  if (open < MOCKUP_LIMITS.openPerTarget) return null;
  return refusal(
    'MOCKUP_QUEUE_FULL',
    '/target',
    `${open} mockups already wait on ${target} (at most ${MOCKUP_LIMITS.openPerTarget}); a person decides one before another is proposed.`,
  );
}

export function sourceProjectRefusal(
  from: string,
  attachmentId: string,
  ownerProjectId: string | null,
  projectId: string,
): MockupRefusal | null {
  if (ownerProjectId === projectId) return null;
  if (ownerProjectId === null) {
    return refusal(
      'MOCKUP_SOURCE_NOT_FOUND',
      '/source/attachmentId',
      `no ${from} attachment ${attachmentId} exists; upload it first (forge_uploads request) or send the bytes as contentBase64.`,
    );
  }
  return refusal(
    'MOCKUP_SOURCE_OTHER_PROJECT',
    '/source/attachmentId',
    `${from} attachment ${attachmentId} belongs to another project; a mockup is taken only from an upload in this project.`,
  );
}

export function decidedRefusal(key: string, status: MockupStatus): MockupRefusal | null {
  if (status === 'proposed') return null;
  return refusal(
    'MOCKUP_DECIDED',
    '/status',
    `${key} is ${status}; only a proposed mockup is accepted, returned or withdrawn. Propose a new one to change it.`,
  );
}

// cm:guard accept and return are a person's acts (S0 PERSON_ACT), and the person who proposed a
// mockup never accepts it (MOCKUP_ACCEPT_OWN_FORBIDDEN), the suggestion two-party rule
export function deciderRefusal(
  facts: PersonActFacts,
  projectId: string,
  key: string,
  act: 'accept' | 'return',
  proposedBy: string,
): MockupRefusal | null {
  const person = personActRefusal(
    facts,
    projectId,
    `${act === 'accept' ? 'accepting' : 'returning'} ${key}`,
    'MOCKUP_DECIDE_FORBIDDEN' as const,
  );
  if (person) return person;
  if (act === 'accept' && proposedBy === facts.userId) {
    return refusal(
      'MOCKUP_ACCEPT_OWN_FORBIDDEN',
      '',
      `${facts.userId} proposed ${key}; somebody else accepts it.`,
    );
  }
  return null;
}

export function returnReasonRefusal(reason: string | null | undefined): MockupRefusal | null {
  if (reason?.trim()) return null;
  return refusal(
    'MOCKUP_REASON_REQUIRED',
    '/reason',
    'a returned mockup says why, so its author knows what the next one should change.',
  );
}

export function withdrawRefusal(key: string, userId: string, proposedBy: string) {
  if (userId === proposedBy) return null;
  return refusal(
    'MOCKUP_WITHDRAW_FORBIDDEN',
    '',
    `${userId} did not propose ${key}; its author withdraws it, a person returns it with a reason.`,
  );
}
