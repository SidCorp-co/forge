import { COMMENT_REFUSAL_CODES, createEntityCommentRequestSchema } from '@forge/contracts/comments';
import { describe, expect, it } from 'vitest';
import type { ActorFacts } from '../lib/person-act.js';
import {
  arcOf,
  contentRefusals,
  decisionBody,
  depthRefusal,
  editorRefusal,
  editRefusals,
  parentRefusal,
  posterRefusal,
  preparedBody,
  recordKeptRefusal,
  scopeOfArc,
  scopeRefusal,
} from './entity-rules.js';

const person: ActorFacts = { userId: 'u1', agency: 'human', role: 'member' };
const agent: ActorFacts = { userId: 'a1', agency: 'agent', role: 'member' };
const viewer: ActorFacts = { userId: 'v1', agency: 'human', role: 'viewer' };
const admin: ActorFacts = { userId: 'ad', agency: 'human', role: 'admin' };
const decided = { decision: 'Keep D1', reason: 'the owner ruled it' };

describe('a comment sits on exactly one target (kernel)', () => {
  it('lets exactly one arm through, for every scope', () => {
    for (const scope of ['issue', 'requirement', 'workflow', 'feedback'] as const) {
      const arc = arcOf(scope, 't1');
      expect(scopeRefusal(arc)).toBeNull();
      expect(scopeOfArc(arc)).toBe(scope);
    }
  });

  it('refuses an arc naming no target, and one naming two, by name', () => {
    expect(scopeRefusal({})?.code).toBe('COMMENT_SCOPE_INVALID');
    const twin = scopeRefusal({ issueId: 'i1', requirementId: 'r1' }, '/data');
    expect(twin).toMatchObject({ code: 'COMMENT_SCOPE_INVALID', path: '/data' });
    expect(twin?.detail).toContain('issue and requirement');
    expect(scopeOfArc({ workflowId: 'w1', feedbackId: 'f1' })).toBeNull();
  });
});

describe('a decision carries what was decided and why', () => {
  it('takes a decision with its fields and no body, and a note with a body', () => {
    expect(contentRefusals({ intent: 'decision', decision: decided })).toEqual([]);
    expect(contentRefusals({ intent: 'note', body: 'seen' })).toEqual([]);
  });

  it('refuses a decision without fields, fields on a note, and a blank question', () => {
    expect(contentRefusals({ intent: 'decision', body: 'we chose X' }).map((r) => r.code)).toEqual([
      'COMMENT_DECISION_REQUIRED',
    ]);
    expect(
      contentRefusals({ intent: 'note', body: 'x', decision: decided }).map((r) => r.code),
    ).toEqual(['COMMENT_DECISION_INTENT_MISMATCH']);
    expect(contentRefusals({ intent: 'question', body: '  ' }).map((r) => r.code)).toEqual([
      'COMMENT_BODY_REQUIRED',
    ]);
  });

  it('refuses a decision whose reason is missing at the schema, naming the field', () => {
    const parsed = createEntityCommentRequestSchema.safeParse({
      intent: 'decision',
      decision: { decision: 'Keep D1' },
    });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.path).toEqual(['decision', 'reason']);
  });

  it('builds a readable body from the fields', () => {
    const body = decisionBody({ ...decided, options: ['A', 'B'], reversedWhen: 'REQ-3 moves' });
    expect(body).toContain('**Reason:** the owner ruled it');
    expect(body).toContain('**Options considered:** A; B');
  });
});

describe('an edit', () => {
  it('names something to change, and decision fields only on a decision', () => {
    expect(editRefusals('note', {})[0]?.code).toBe('COMMENT_BODY_REQUIRED');
    expect(editRefusals('note', { decision: decided })[0]?.code).toBe(
      'COMMENT_DECISION_INTENT_MISMATCH',
    );
    expect(editRefusals('decision', { decision: decided })).toEqual([]);
  });
});

describe('who may post and edit', () => {
  it('lets a member person and the project agent post; refuses a viewer', () => {
    expect(posterRefusal(person, 'REQ-11')).toBeNull();
    expect(posterRefusal(agent, 'REQ-11')).toBeNull();
    expect(posterRefusal(viewer, 'REQ-11')?.code).toBe('COMMENT_POST_FORBIDDEN');
    expect(posterRefusal({ ...agent, role: null }, 'REQ-11')?.code).toBe('COMMENT_POST_FORBIDDEN');
  });

  it('lets the author or a project admin person edit; refuses another member and an agent', () => {
    expect(editorRefusal(agent, 'a1', 'REQ-11')).toBeNull();
    expect(editorRefusal(admin, 'u1', 'REQ-11')).toBeNull();
    expect(editorRefusal(person, 'a1', 'REQ-11')?.code).toBe('COMMENT_EDIT_FORBIDDEN');
    expect(editorRefusal({ ...agent, role: 'admin' }, 'u1', 'REQ-11')?.code).toBe(
      'COMMENT_EDIT_FORBIDDEN',
    );
  });
});

describe('threads', () => {
  it('refuses a parent on another target, and a missing one, by name', () => {
    const onReq = { arc: arcOf('requirement', 'r1') };
    expect(parentRefusal(onReq, 'p1', 'requirement', 'r1', 'REQ-1')).toBeNull();
    expect(parentRefusal(onReq, 'p1', 'requirement', 'r2', 'REQ-2')?.code).toBe(
      'COMMENT_PARENT_MISMATCH',
    );
    expect(parentRefusal(null, 'p1', 'workflow', 'w1', 'hop-flow')?.detail).toBe(
      'hop-flow holds no comment p1',
    );
  });

  it('refuses a reply nested past three', () => {
    expect(depthRefusal(3, 'REQ-1')).toBeNull();
    expect(depthRefusal(4, 'REQ-1')?.code).toBe('COMMENT_DEPTH_EXCEEDED');
  });
});

describe('bodies and records', () => {
  it('refuses an html body that is empty once sanitised', () => {
    const out = preparedBody('<script>x</script>', 'html');
    expect(out.ok).toBe(false);
    expect(out.ok ? null : out.refusal.code).toBe('COMMENT_BODY_INVALID');
  });

  it('keeps a comment on an entity: a delete is refused', () => {
    expect(recordKeptRefusal('c1', 'requirement').code).toBe('COMMENT_RECORD_KEPT');
  });

  it('covers every declared refusal code', () => {
    const planted = [
      scopeRefusal({}),
      contentRefusals({ intent: 'decision' })[0],
      contentRefusals({ intent: 'note', body: 'x', decision: decided })[0],
      contentRefusals({ intent: 'note' })[0],
      preparedBody('<script>x</script>', 'html'),
      parentRefusal(null, 'p', 'feedback', 'f', 'FB-1'),
      depthRefusal(4, 'FB-1'),
      posterRefusal(viewer, 'FB-1'),
      editorRefusal(person, 'other', 'FB-1'),
      recordKeptRefusal('c', 'feedback'),
    ].map((r) => (r && 'refusal' in r ? r.refusal.code : r && 'code' in r ? r.code : null));
    expect(new Set(planted)).toEqual(new Set(COMMENT_REFUSAL_CODES));
  });
});
