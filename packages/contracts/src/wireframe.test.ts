import { describe, expect, it } from 'vitest';
import { parseUiAction, uiActionJsonSchema, uiSnapshotSchema } from './ui-actions.js';
import { applyWireframePatch, parseWireframe, type WireframeDoc } from './wireframe.js';

const board = (): WireframeDoc => ({
  v: 'wireframe-v1',
  title: 'Release page',
  shapes: [
    { type: 'frame', id: 'page', x: 0, y: 0, w: 1200, h: 800, label: 'Release' },
    { type: 'list', id: 'changelog', x: 40, y: 80, w: 500, h: 600, items: ['fix', 'feat'] },
    { type: 'text', id: 'deploylog', x: 600, y: 80, w: 500, h: 600, text: 'deploy log' },
    { type: 'button', id: 'ship', x: 40, y: 720, w: 160, h: 48, label: 'Ship' },
    { type: 'arrow', id: 'a1', from: { id: 'ship' }, to: { id: 'deploylog' } },
    { type: 'pen', id: 'p1', points: [[10, 10], [20, 30]] },
  ],
});

describe('wireframe-v1 — the closed document', () => {
  it('accepts every shape in the closed set', () => {
    expect(parseWireframe(board())).toMatchObject({ ok: true });
  });

  it('refuses a shape outside the closed set by name', () => {
    const doc = board();
    (doc.shapes as unknown[]).push({ type: 'ellipse', id: 'e', x: 1, y: 1, w: 1, h: 1 });
    expect(parseWireframe(doc)).toMatchObject({ ok: false, code: 'WIREFRAME_SHAPE_UNKNOWN', path: 'shapes.6.type' });
  });

  it('refuses geometry off the canvas — negative, past the edge, a zero size, an arrow point, a pen point', () => {
    const at = (shape: unknown) => parseWireframe({ v: 'wireframe-v1', shapes: [shape] });
    expect(at({ type: 'frame', id: 'f', x: -1, y: 0, w: 10, h: 10 })).toMatchObject({ code: 'WIREFRAME_OUT_OF_BOUNDS', path: 'shapes.0.x' });
    expect(at({ type: 'frame', id: 'f', x: 3990, y: 0, w: 20, h: 10 })).toMatchObject({ code: 'WIREFRAME_OUT_OF_BOUNDS', path: 'shapes.0.w' });
    expect(at({ type: 'frame', id: 'f', x: 0, y: 0, w: 0, h: 10 })).toMatchObject({ code: 'WIREFRAME_OUT_OF_BOUNDS', path: 'shapes.0.w' });
    expect(at({ type: 'arrow', id: 'a', from: { x: 0, y: 4001 }, to: { x: 1, y: 1 } })).toMatchObject({ code: 'WIREFRAME_OUT_OF_BOUNDS', path: 'shapes.0.from.y' });
    expect(at({ type: 'pen', id: 'p', points: [[0, 0], [5000, 1]] })).toMatchObject({ code: 'WIREFRAME_OUT_OF_BOUNDS', path: 'shapes.0.points.1' });
    expect(at({ type: 'frame', id: 'f', x: 3990, y: 0, w: 10, h: 10 })).toMatchObject({ ok: true });
  });

  it('refuses a duplicate id', () => {
    const doc = board();
    doc.shapes.push({ type: 'button', id: 'ship', x: 1, y: 1, w: 10, h: 10, label: 'again' });
    expect(parseWireframe(doc)).toMatchObject({ ok: false, code: 'WIREFRAME_DUPLICATE_ID', path: 'shapes.6.id' });
  });

  it('refuses an arrow to a missing id, and one to itself', () => {
    const doc = board();
    doc.shapes.push({ type: 'arrow', id: 'a2', from: { id: 'ship' }, to: { id: 'nowhere' } });
    const r = parseWireframe(doc);
    expect(r).toMatchObject({ ok: false, code: 'WIREFRAME_ARROW_DANGLING', path: 'shapes.6.to.id' });
    if (!r.ok) expect(r.message).toContain('"nowhere"');
    const self = board();
    self.shapes.push({ type: 'arrow', id: 'a3', from: { id: 'a3' }, to: { id: 'ship' } });
    expect(parseWireframe(self)).toMatchObject({ code: 'WIREFRAME_ARROW_DANGLING' });
  });

  it('refuses fields outside a shape rather than dropping them', () => {
    const doc = board();
    (doc.shapes[3] as Record<string, unknown>).color = 'red';
    expect(parseWireframe(doc)).toMatchObject({ ok: false, code: 'WIREFRAME_INVALID' });
    expect(parseWireframe({ v: 'wireframe-v2', shapes: [] })).toMatchObject({ code: 'WIREFRAME_INVALID', path: 'v' });
  });
});

describe('applyWireframePatch — revisions by shape id', () => {
  it('moves one shape and leaves the rest as they were', () => {
    const r = applyWireframePatch(board(), [
      { op: 'update', id: 'deploylog', set: { x: 40 } },
      { op: 'update', id: 'changelog', set: { x: 600 } },
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.doc.shapes.find((s) => s.id === 'deploylog')).toMatchObject({ x: 40 });
      expect(r.doc.shapes.find((s) => s.id === 'ship')).toEqual(board().shapes[3]);
    }
  });

  it('refuses an edit to a missing id, a move off the canvas, and a removal that strands an arrow', () => {
    expect(applyWireframePatch(board(), [{ op: 'update', id: 'gone', set: { x: 1 } }])).toMatchObject({ code: 'WIREFRAME_ID_MISSING' });
    expect(applyWireframePatch(board(), [{ op: 'update', id: 'ship', set: { x: 3900 } }])).toMatchObject({ code: 'WIREFRAME_OUT_OF_BOUNDS' });
    expect(applyWireframePatch(board(), [{ op: 'remove', id: 'ship' }])).toMatchObject({ code: 'WIREFRAME_ARROW_DANGLING' });
    expect(applyWireframePatch(board(), [{ op: 'update', id: 'ship', set: { type: 'text' } }])).toMatchObject({ code: 'WIREFRAME_INVALID' });
  });
});

describe('the board rides the UI-action channel', () => {
  it('ui.board.draw carries the wireframe refusal code, not a generic one', () => {
    const doc = board();
    (doc.shapes as unknown[]).push({ type: 'diamond', id: 'd', x: 1, y: 1, w: 1, h: 1 });
    expect(parseUiAction('ui_board_draw', { doc })).toMatchObject({ ok: false, code: 'WIREFRAME_SHAPE_UNKNOWN', name: 'ui.board.draw' });
    expect(parseUiAction('ui.board.draw', { doc: board() })).toMatchObject({ ok: true, action: { name: 'ui.board.draw' } });
    expect(parseUiAction('ui.board.revise', { ops: [{ op: 'add', shape: { type: 'frame', id: 'x', x: 0, y: 0, w: 9000, h: 1 } }] }))
      .toMatchObject({ ok: false, code: 'WIREFRAME_OUT_OF_BOUNDS' });
    expect(parseUiAction('ui.board.revise', { ops: [] })).toMatchObject({ ok: false, code: 'UI_ACTION_INVALID' });
  });

  it('offers a JSON schema the model can read, and the snapshot carries the board back', () => {
    expect(JSON.stringify(uiActionJsonSchema('ui.board.draw'))).toContain('"frame"');
    expect(uiSnapshotSchema.safeParse({ v: 1, route: 'issues', path: '/p', board: board() }).success).toBe(true);
    expect(uiSnapshotSchema.safeParse({ v: 1, route: 'issues', path: '/p', board: { v: 'wireframe-v1', shapes: [{ type: 'blob' }] } }).success).toBe(false);
  });
});
