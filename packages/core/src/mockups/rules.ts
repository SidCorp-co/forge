/**
 * The guards of a mockup (MK-n, ISS-78) as pure functions over what the service read: what a
 * proposal may carry, which target it may be about, which returned mockup it revises and which
 * comments that revision settles, where a comment may point, and who may accept, return or withdraw
 * it. Each refusal is named; nothing is written.
 */

import { withArticle } from '@forge/contracts/articles';
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
import { type PermissionFacts, permissionRefusal } from '../permissions/index.js';

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
    `${why ?? `${mime || 'this type'} is not ${withArticle(kind)} mockup`}; ${withArticle(kind)} mockup is ${MOCKUP_KIND_MIMES[kind].join(' or ')}.`,
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
    `the ${kind} mockup is ${size} bytes; ${withArticle(kind)} mockup holds at most ${most}.`,
  );
}

// A requirement mockup is proposed against a revision that can still be agreed (REQ-49 BC-5): the
// current one or the open draft or proposed one. A superseded or withdrawn revision is evidence and
// takes nothing (MOCKUP_REVISION_SUPERSEDED); an accepted mockup is pinned only by a baseline written
// after the accept, so nothing under an agreed baseline changes silently
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
  if (state === 'draft' || state === 'proposed' || state === 'current') return null;
  return refusal(
    'MOCKUP_REVISION_SUPERSEDED',
    '/target/revision',
    `${key} revision ${revision} is ${state}${head === null ? '' : `; its head is revision ${head}`}; propose the mockup against revision ${head ?? revision} or the open draft instead.`,
  );
}

/** A next revision names a returned mockup that has none yet, and stays on its item (REQ-49 BC-3). */
export function revisesRefusal(
  key: string,
  status: MockupStatus,
  revisedBy: string | null,
): MockupRefusal | null {
  if (revisedBy) {
    return refusal(
      'MOCKUP_REVISES_INVALID',
      '/revises',
      `${key} already has its next revision, ${revisedBy}; revise ${revisedBy} once it is returned.`,
    );
  }
  if (status === 'returned') return null;
  return refusal(
    'MOCKUP_REVISES_INVALID',
    '/revises',
    `${key} is ${status}; only a returned mockup is proposed again as its next revision.${status === 'proposed' ? ' Its author withdraws it, or a person returns it first.' : ''}`,
  );
}

export function revisesTargetRefusal(key: string, revisedTarget: string, named: string) {
  if (revisedTarget === named) return null;
  return refusal(
    'MOCKUP_REVISES_INVALID',
    '/target',
    `${key} is about ${revisedTarget}; its next revision stays on that item, not ${named}. Leave target out to keep it.`,
  );
}

export function settlesWithoutRevisesRefusal(input: ProposeMockupRequest): MockupRefusal | null {
  if (input.revises || (!input.answers?.length && !input.resolves?.length)) return null;
  return refusal(
    'MOCKUP_REVISES_INVALID',
    '/revises',
    'answers and resolves settle comments on the mockup a next revision revises; name it as revises (MK-n).',
  );
}

export interface OpenComment {
  id: string;
  settled: string | null;
}

/**
 * Each comment a next revision answers or resolves is an open comment on the mockup it revises or
 * on an earlier revision of it, named once (REQ-49 BC-2).
 */
export function settleRefusals(
  key: string,
  chain: ReadonlyMap<string, OpenComment>,
  answers: readonly string[],
  resolves: readonly string[],
): MockupRefusal[] {
  const out: MockupRefusal[] = [];
  const seen = new Set<string>();
  const check = (id: string, path: string) => {
    const c = chain.get(id);
    if (!c) {
      out.push(
        refusal(
          'MOCKUP_COMMENT_UNKNOWN',
          path,
          `comment ${id} is not on ${key} or a revision before it; read them with GET …/mockups/${key}/comments.`,
        ),
      );
    } else if (c.settled) {
      out.push(refusal('MOCKUP_COMMENT_SETTLED', path, `comment ${id} is already ${c.settled}.`));
    } else if (seen.has(id)) {
      out.push(
        refusal(
          'MOCKUP_COMMENT_SETTLED',
          path,
          `comment ${id} is named twice; a revision answers or resolves it once.`,
        ),
      );
    }
    seen.add(id);
  };
  for (const [i, id] of answers.entries()) check(id, `/answers/${i}/comment`);
  for (const [i, id] of resolves.entries()) check(id, `/resolves/${i}/comment`);
  return out;
}

/** A comment goes on a mockup that is still under discussion: proposed, or returned with no next revision yet. */
export function commentClosedRefusal(
  key: string,
  status: MockupStatus,
  revisedBy: string | null,
): MockupRefusal | null {
  if (revisedBy) {
    return refusal(
      'MOCKUP_COMMENT_CLOSED',
      '',
      `${key} was revised by ${revisedBy}; comment on ${revisedBy}.`,
    );
  }
  if (status === 'proposed' || status === 'returned') return null;
  return refusal(
    'MOCKUP_COMMENT_CLOSED',
    '',
    `${key} is ${status}; a comment shapes a mockup still proposed or returned. Propose a new one to change it.`,
  );
}

export function commentsFullRefusal(key: string, count: number): MockupRefusal | null {
  if (count < MOCKUP_LIMITS.commentsPerMockup) return null;
  return refusal(
    'MOCKUP_COMMENTS_FULL',
    '',
    `${key} holds ${count} comments (at most ${MOCKUP_LIMITS.commentsPerMockup}); return it and answer them in a next revision.`,
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
      `no ${from} attachment ${attachmentId} exists; upload it first (POST /api/issues/:id/attachments) or send the bytes as contentBase64.`,
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

// Accept and return are approvals (ADR 0007): whoever holds mockups.approve decides, its author included.
export function deciderRefusal(
  facts: PermissionFacts,
  key: string,
  act: 'accept' | 'return',
): MockupRefusal | null {
  return permissionRefusal(
    facts,
    'mockups.approve',
    `${act === 'accept' ? 'accepting' : 'returning'} ${key}`,
  );
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
    `${userId} did not propose ${key}; its author withdraws it, a holder of mockups.approve returns it with a reason.`,
  );
}
