import { describe, it, expect } from 'vitest';
import { __testing } from '@/features/activity/api/activity-api';

const { mapAction, toLegacy } = __testing;

const baseRow = {
  id: 'row-1',
  issueId: 'issue-1',
  actorType: 'user' as const,
  actorId: 'user-1',
  createdAt: '2026-01-01T00:00:00.000Z',
};

describe('activity mapAction', () => {
  it('maps issue.created -> created', () => {
    expect(mapAction('issue.created', {})).toMatchObject({ type: 'created' });
  });

  it('maps issue.statusChanged with from/to', () => {
    expect(mapAction('issue.statusChanged', { from: 'open', to: 'confirmed' })).toMatchObject({
      type: 'status_change',
      fromValue: 'open',
      toValue: 'confirmed',
    });
  });

  it('maps issue.updated priority', () => {
    expect(
      mapAction('issue.updated', {
        fields: ['priority'],
        before: { priority: 'low' },
        after: { priority: 'high' },
      }),
    ).toMatchObject({
      type: 'priority_change',
      field: 'priority',
      fromValue: 'low',
      toValue: 'high',
    });
  });

  it('maps issue.updated complexity', () => {
    expect(
      mapAction('issue.updated', {
        fields: ['complexity'],
        before: { complexity: 's' },
        after: { complexity: 'm' },
      }),
    ).toMatchObject({
      type: 'complexity_change',
      fromValue: 's',
      toValue: 'm',
    });
  });

  it('maps issue.updated category', () => {
    expect(
      mapAction('issue.updated', {
        fields: ['category'],
        before: { category: 'a' },
        after: { category: 'b' },
      }),
    ).toMatchObject({ type: 'category_change', fromValue: 'a', toValue: 'b' });
  });

  it('maps issue.updated title', () => {
    expect(
      mapAction('issue.updated', {
        fields: ['title'],
        before: { title: 'old' },
        after: { title: 'new' },
      }),
    ).toMatchObject({ type: 'title_change', fromValue: 'old', toValue: 'new' });
  });

  it('maps issue.updated description -> edited', () => {
    expect(
      mapAction('issue.updated', { fields: ['description'], before: {}, after: {} }),
    ).toMatchObject({ type: 'edited', field: 'description' });
  });

  it('maps multi-field issue.updated -> edited multiple', () => {
    expect(
      mapAction('issue.updated', { fields: ['priority', 'category'], before: {}, after: {} }),
    ).toMatchObject({ type: 'edited', field: 'multiple' });
  });

  it('maps issue.assigned -> assignee_change', () => {
    expect(mapAction('issue.assigned', { before: 'u1', after: 'u2' })).toMatchObject({
      type: 'assignee_change',
      fromValue: 'u1',
      toValue: 'u2',
    });
  });

  it('maps issue.labeled / unlabeled with labelId metadata', () => {
    expect(mapAction('issue.labeled', { labelId: 'lbl-1' })).toMatchObject({
      type: 'label_added',
      toValue: 'lbl-1',
      metadata: { labelId: 'lbl-1' },
    });
    expect(mapAction('issue.unlabeled', { labelId: 'lbl-1' })).toMatchObject({
      type: 'label_removed',
      fromValue: 'lbl-1',
    });
  });

  it('maps issue.dependency.added / removed', () => {
    const payload = { fromIssueId: 'a', toIssueId: 'b', kind: 'blocks' };
    expect(mapAction('issue.dependency.added', payload)).toMatchObject({
      type: 'relation_added',
      fromValue: 'a',
      toValue: 'b',
    });
    expect(mapAction('issue.dependency.removed', payload)).toMatchObject({
      type: 'relation_removed',
    });
  });

  it('maps comment.created with body', () => {
    expect(mapAction('comment.created', { body: 'hi' })).toMatchObject({
      type: 'comment',
      body: 'hi',
    });
  });

  it('maps comment.deleted with deleted metadata', () => {
    const r = mapAction('comment.deleted', { commentId: 'c1' });
    expect(r.type).toBe('comment');
    expect(r.metadata).toMatchObject({ deleted: true });
  });

  it('maps agent-session.created with sessionId metadata', () => {
    expect(mapAction('agent-session.created', { sessionId: 's1', title: 't' })).toMatchObject({
      type: 'agent_session',
      metadata: { sessionId: 's1', title: 't' },
    });
  });

  it('maps pikachu.* -> pikachu_decision', () => {
    expect(mapAction('pikachu.evaluated', {})).toMatchObject({ type: 'pikachu_decision' });
  });

  it('falls back to created for unknown actions', () => {
    expect(mapAction('unknown.thing', {})).toMatchObject({ type: 'created' });
  });
});

describe('activity toLegacy', () => {
  it('populates fromValue/toValue/field for status change', () => {
    const a = toLegacy(
      { ...baseRow, action: 'issue.statusChanged', payload: { from: 'open', to: 'confirmed' } },
      'issue-1',
    );
    expect(a.type).toBe('status_change');
    expect(a.fromValue).toBe('open');
    expect(a.toValue).toBe('confirmed');
    expect(a.actor).toBe('user-1');
    expect(a.isAI).toBe(false);
  });

  it('marks device actor as AI', () => {
    const a = toLegacy(
      { ...baseRow, actorType: 'device', action: 'agent-session.created', payload: { sessionId: 's' } },
      'issue-1',
    );
    expect(a.isAI).toBe(true);
    expect(a.type).toBe('agent_session');
  });
});
