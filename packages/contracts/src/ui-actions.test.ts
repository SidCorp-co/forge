import { describe, expect, it } from 'vitest';
import { describeUiSnapshot, parseUiAction, uiActionJsonSchema, uiSnapshotSchema } from './ui-actions.js';

describe('parseUiAction — the closed registry', () => {
  it('accepts the dotted name and its exact wire form, stamped with the version', () => {
    const dotted = parseUiAction('ui.issues.filter', { mode: 'merge', set: { priority: 'high' } });
    const wire = parseUiAction('ui_issues_filter', { mode: 'merge', set: { priority: 'high' } });
    expect(dotted).toEqual(wire);
    expect(dotted).toMatchObject({ ok: true, action: { name: 'ui.issues.filter', v: 1, params: { mode: 'merge', set: { priority: 'high' }, clear: [] } } });
  });

  it('refuses an action outside the registry by name, and never maps a near miss', () => {
    for (const name of ['ui.delete', 'ui.issues.update', 'ui-navigate', 'UI_NAVIGATE', 'forge_cli']) {
      const r = parseUiAction(name, { route: 'issues' });
      expect(r).toMatchObject({ ok: false, code: 'UI_ACTION_UNKNOWN', name });
      if (!r.ok) expect(r.message).toContain(`"${name}" is not a UI action`);
    }
  });

  it('refuses params outside the closed fields rather than dropping them', () => {
    const r = parseUiAction('ui.issues.filter', { mode: 'merge', set: { priority: 'high', label: 'bug' } });
    expect(r).toMatchObject({ ok: false, code: 'UI_ACTION_INVALID', name: 'ui.issues.filter' });
    if (!r.ok) expect(r.message).toMatch(/set.*label|label/);
    expect(parseUiAction('ui.navigate', { route: 'issues', then: 'delete' })).toMatchObject({ ok: false, code: 'UI_ACTION_INVALID' });
  });

  it('refuses a route not in the closed list and a key that is not one', () => {
    expect(parseUiAction('ui.navigate', { route: 'admin' })).toMatchObject({ ok: false, code: 'UI_ACTION_INVALID' });
    expect(parseUiAction('ui.open', { key: '47' })).toMatchObject({ ok: false, code: 'UI_ACTION_INVALID' });
    expect(parseUiAction('ui.select', { keys: ['ISS-1', 'nope'] })).toMatchObject({ ok: false, code: 'UI_ACTION_INVALID' });
  });

  it('createdBy and assignee take only "me" — a user id is refused, not trusted', () => {
    const r = parseUiAction('ui.issues.filter', {
      mode: 'replace',
      set: { createdBy: '6f1c2c1e-6a43-4b8e-9b0c-1c1e2b3c4d5e' },
    });
    expect(r).toMatchObject({ ok: false, code: 'UI_ACTION_INVALID' });
  });

  it('merge vs replace is explicit: a missing mode is refused, an empty merge is refused', () => {
    expect(parseUiAction('ui.issues.filter', { set: { priority: 'high' } })).toMatchObject({ ok: false, code: 'UI_ACTION_INVALID' });
    expect(parseUiAction('ui.issues.filter', { mode: 'merge' })).toMatchObject({ ok: false, code: 'UI_ACTION_INVALID' });
    expect(parseUiAction('ui.issues.filter', { mode: 'replace' })).toMatchObject({ ok: true });
  });

  it('refuses a field both set and cleared rather than picking one', () => {
    const r = parseUiAction('ui.issues.filter', { mode: 'merge', set: { priority: 'high' }, clear: ['priority'] });
    expect(r).toMatchObject({ ok: false, code: 'UI_ACTION_INVALID' });
  });

  it('refuses a status the lifecycle does not have', () => {
    expect(parseUiAction('ui.issues.filter', { mode: 'merge', set: { status: ['openish'] } })).toMatchObject({ ok: false, code: 'UI_ACTION_INVALID' });
  });

  it('offers each action to the model as a closed JSON schema', () => {
    const schema = uiActionJsonSchema('ui.navigate');
    expect(schema).toMatchObject({ type: 'object', additionalProperties: false, required: ['route'] });
    expect(schema).not.toHaveProperty('$schema');
  });
});

describe('uiSnapshotSchema', () => {
  it('reads as the "Sees" line, and refuses a scraped field', () => {
    const s = uiSnapshotSchema.parse({ v: 1, route: 'issues', path: '/projects/x/issues', filter: { createdBy: 'me', priority: 'high' } });
    expect(describeUiSnapshot(s)).toBe('issues · created by me · priority high');
    expect(uiSnapshotSchema.safeParse({ v: 1, route: 'issues', path: '/', html: '<div>' }).success).toBe(false);
    expect(uiSnapshotSchema.safeParse({ v: 2, route: 'issues', path: '/' }).success).toBe(false);
  });
});
