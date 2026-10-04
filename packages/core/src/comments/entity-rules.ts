import {
  COMMENT_SCOPES,
  type CommentRefusal,
  type CommentScope,
  type DecisionFields,
} from '@forge/contracts/comments';
import type { CommentIntent } from '@forge/contracts/record-events';
import { BodyInvalidError } from '../body/errors.js';
import { prepareBody } from '../body/prepare.js';
import { holds, type PermissionFacts, permissionRefusal } from '../permissions/index.js';

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

export const posterRefusal = (facts: PermissionFacts, targetKey: string): CommentRefusal | null =>
  permissionRefusal(facts, 'project.write', `posting a comment on ${targetKey}`);

/** Its author edits a comment while holding project.write; anyone else needs comments.moderate. */
export function editorRefusal(
  facts: PermissionFacts,
  isAuthor: boolean,
  targetKey: string,
): CommentRefusal | null {
  if (isAuthor) return permissionRefusal(facts, 'project.write', `editing a comment on ${targetKey}`);
  return holds(facts, 'comments.moderate')
    ? null
    : permissionRefusal(facts, 'comments.moderate', `editing another's comment on ${targetKey}`);
}

export function decisionBody(d: DecisionFields): string {
  const lines = [`**Decision:** ${d.decision}`, `**Reason:** ${d.reason}`];
  if (d.options?.length) lines.push(`**Options considered:** ${d.options.join('; ')}`);
  if (d.authority) lines.push(`**Authority:** ${d.authority}`);
  if (d.reversedWhen) lines.push(`**Reversed when:** ${d.reversedWhen}`);
  if (d.node) {
    const at = 'step' in d.node ? d.node.step : `${d.node.edge.from} > ${d.node.edge.to}`;
    lines.push(`**Node:** ${at}: ${d.node.verdict}`);
  }
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

// cm:guard decision.node names a node of a workflow, so it sits on a workflow decision only (REQ-17 BC-26)
export function nodeDecisionScopeRefusal(
  scope: string,
  targetKey: string,
  decision: DecisionFields | undefined,
): CommentRefusal | null {
  if (!decision?.node || scope === 'workflow') return null;
  return {
    code: 'COMMENT_DECISION_NODE_SCOPE',
    path: '/decision/node',
    detail: `decision.node names a step or edge of a workflow; this decision sits on a ${scope} (${targetKey}). Post it on the workflow, or drop the node`,
  };
}
