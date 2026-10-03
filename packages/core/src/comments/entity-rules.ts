import {
  COMMENT_SCOPES,
  type CommentRefusal,
  type CommentScope,
  type DecisionFields,
} from '@forge/contracts/comments';
import type { CommentIntent } from '@forge/contracts/record-events';
import { BodyInvalidError } from '../body/errors.js';
import { prepareBody } from '../body/prepare.js';
import { type ActorFacts, type ActRule, actMiss, PERSON_ADMIN_ACT } from '../lib/person-act.js';

export const COMMENT_POST: ActRule = { person: 'member', agent: 'member' };

export interface CommentArc {
  issueId?: string | null | undefined;
  requirementId?: string | null | undefined;
  workflowId?: string | null | undefined;
  feedbackId?: string | null | undefined;
}

const ARC_COLUMNS: Record<CommentScope, keyof CommentArc> = {
  issue: 'issueId',
  requirement: 'requirementId',
  workflow: 'workflowId',
  feedback: 'feedbackId',
};

export function arcOf(scope: CommentScope, targetId: string): Required<CommentArc> {
  const arc = { issueId: null, requirementId: null, workflowId: null, feedbackId: null };
  return { ...arc, [ARC_COLUMNS[scope]]: targetId };
}

export function scopeOfArc(arc: CommentArc): CommentScope | null {
  const set = COMMENT_SCOPES.filter((s) => !!arc[ARC_COLUMNS[s]]);
  return set.length === 1 ? (set[0] as CommentScope) : null;
}

export function sitsOn(arc: CommentArc, scope: CommentScope, targetId: string): boolean {
  return scopeOfArc(arc) === scope && arc[ARC_COLUMNS[scope]] === targetId;
}

// cm:guard a comment sits on exactly one of issue | requirement | workflow | feedback; the door
// refuses any other arc by name before comments_scope_chk would refuse it at the table
export function scopeRefusal(arc: CommentArc, path = ''): CommentRefusal | null {
  const named = COMMENT_SCOPES.filter((s) => !!arc[ARC_COLUMNS[s]]);
  if (named.length === 1) return null;
  return {
    code: 'COMMENT_SCOPE_INVALID',
    path,
    detail:
      named.length === 0
        ? `a comment names no target; name exactly one of ${COMMENT_SCOPES.join(' | ')}`
        : `a comment names ${named.join(' and ')}; it sits on exactly one of ${COMMENT_SCOPES.join(' | ')}`,
  };
}

export interface CommentContent {
  intent: CommentIntent;
  body?: string | undefined;
  decision?: DecisionFields | undefined;
}

// cm:guard a decision carries what was decided and why as fields, and no other intent carries them,
// so a reader never has to parse prose to find the reason
export function contentRefusals(c: CommentContent): CommentRefusal[] {
  const out: CommentRefusal[] = [];
  if (c.intent === 'decision' && !c.decision) {
    out.push({
      code: 'COMMENT_DECISION_REQUIRED',
      path: '/decision',
      detail:
        'a decision carries its structured body: decision: { decision, reason } at least, with options, authority and reversedWhen when they are known',
    });
  }
  if (c.intent !== 'decision' && c.decision) {
    out.push({
      code: 'COMMENT_DECISION_INTENT_MISMATCH',
      path: '/decision',
      detail: `decision fields belong to intent decision; this comment is a ${c.intent}. Send intent: decision, or drop the decision fields`,
    });
  }
  if (c.intent !== 'decision' && !c.body?.trim()) {
    out.push({
      code: 'COMMENT_BODY_REQUIRED',
      path: '/body',
      detail: `a ${c.intent} carries a body: the sentence somebody is meant to read`,
    });
  }
  return out;
}

export function editRefusals(
  intent: CommentIntent,
  edit: { body?: string | undefined; decision?: DecisionFields | undefined },
): CommentRefusal[] {
  if (edit.body === undefined && edit.decision === undefined) {
    return [
      {
        code: 'COMMENT_BODY_REQUIRED',
        path: '',
        detail: 'an edit names a new body, new decision fields, or both',
      },
    ];
  }
  if (edit.body !== undefined && !edit.body.trim()) {
    return [{ code: 'COMMENT_BODY_REQUIRED', path: '/body', detail: 'a body is not blank' }];
  }
  if (edit.decision && intent !== 'decision') {
    return [
      {
        code: 'COMMENT_DECISION_INTENT_MISMATCH',
        path: '/decision',
        detail: `decision fields belong to intent decision; this comment is a ${intent}, and an edit never changes the intent`,
      },
    ];
  }
  return [];
}

export function parentRefusal(
  parent: { arc: CommentArc } | null,
  parentId: string,
  scope: CommentScope,
  targetId: string,
  targetKey: string,
): CommentRefusal | null {
  if (parent && sitsOn(parent.arc, scope, targetId)) return null;
  return {
    code: 'COMMENT_PARENT_MISMATCH',
    path: '/parentId',
    detail: parent
      ? `comment ${parentId} sits on another target; a reply sits on ${targetKey}, as its parent must`
      : `${targetKey} holds no comment ${parentId}`,
  };
}

export function posterRefusal(facts: ActorFacts, targetKey: string): CommentRefusal | null {
  const miss = actMiss(facts, COMMENT_POST);
  if (!miss) return null;
  return {
    code: 'COMMENT_POST_FORBIDDEN',
    path: '',
    detail: `${facts.userId} holds ${facts.role ?? 'no role'} on this project; a comment on ${targetKey} is posted by a member or above, person or the project's own agent`,
  };
}

export function editorRefusal(
  facts: ActorFacts,
  authorId: string,
  targetKey: string,
): CommentRefusal | null {
  if (facts.userId === authorId) {
    const miss = actMiss(facts, COMMENT_POST);
    if (!miss) return null;
  } else if (!actMiss(facts, PERSON_ADMIN_ACT)) {
    return null;
  }
  return {
    code: 'COMMENT_EDIT_FORBIDDEN',
    path: '',
    detail: `${facts.userId} may not edit this comment on ${targetKey}: its author edits it while a member, and otherwise only a project admin person`,
  };
}

export function decisionBody(d: DecisionFields): string {
  const lines = [`**Decision:** ${d.decision}`, `**Reason:** ${d.reason}`];
  if (d.options?.length) lines.push(`**Options considered:** ${d.options.join('; ')}`);
  if (d.authority) lines.push(`**Authority:** ${d.authority}`);
  if (d.reversedWhen) lines.push(`**Reversed when:** ${d.reversedWhen}`);
  return lines.join('\n\n');
}

export const COMMENT_MAX_DEPTH = 3;

export function depthRefusal(depth: number, targetKey: string): CommentRefusal | null {
  if (depth <= COMMENT_MAX_DEPTH) return null;
  return {
    code: 'COMMENT_DEPTH_EXCEEDED',
    path: '/parentId',
    detail: `a thread on ${targetKey} nests ${COMMENT_MAX_DEPTH} deep at most; reply to an earlier comment of it`,
  };
}

export function preparedBody(raw: string, format: 'markdown' | 'html' | undefined) {
  try {
    return { ok: true as const, prepared: prepareBody({ raw, format }) };
  } catch (err) {
    if (!(err instanceof BodyInvalidError)) throw err;
    const refusal: CommentRefusal = {
      code: 'COMMENT_BODY_INVALID',
      path: '/body',
      detail: err.message,
    };
    return { ok: false as const, refusal };
  }
}

export function recordKeptRefusal(commentId: string, scope: CommentScope): CommentRefusal {
  return {
    code: 'COMMENT_RECORD_KEPT',
    path: '/documentId',
    detail: `comment ${commentId} sits on a ${scope}; a comment there is a record and is never deleted. Edit it instead, or post a decision that supersedes it`,
  };
}
