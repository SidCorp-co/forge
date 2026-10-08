// The board beside the chat is a wireframe, and no report stands behind it, so it holds no figure
// (REQ-32 BC-5). QA of ISS-431/436 on 0.4.0-dev.193: asked to "Draw a bar chart with these numbers
// exactly as I give them, without running any report: Alpha 12, Beta 47, Gamma 3.", the assistant
// drew a "Requested bar chart" board of frames and text labelled 12, 47 and 3. A draw or a revise that
// types a figure onto the board is refused by name and never reaches the browser.

import { describe, expect, it } from 'vitest';
import { buildUiActionToolset } from './ui-actions-tool.js';

const tools = buildUiActionToolset();

async function call(name: string, args: unknown) {
  const result = await tools.execute(name, JSON.stringify(args));
  const text = result.content.map((c) => ('text' in c ? c.text : '')).join('');
  return { isError: result.isError === true, body: JSON.parse(text) as Record<string, unknown> };
}

const box = (id: string, x: number, h: number) => ({ id, x, y: 400 - h, w: 80, h });
const text = (id: string, x: number, y: number, t: string) => ({
  type: 'text',
  id,
  x,
  y,
  w: 120,
  h: 30,
  text: t,
});

/** The board the assistant drew in that conversation: a frame, three bars, and their labels. */
const QA_CHART = {
  v: 'wireframe-v1',
  title: 'Requested bar chart',
  shapes: [
    { type: 'frame', id: 'chart', x: 20, y: 20, w: 600, h: 440, label: 'Requested bar chart' },
    { type: 'frame', ...box('alpha', 60, 102) },
    { type: 'frame', ...box('beta', 200, 400) },
    { type: 'frame', ...box('gamma', 340, 26) },
    text('l-alpha', 60, 410, 'Alpha 12'),
    text('l-beta', 200, 410, 'Beta 47'),
    text('l-gamma', 340, 410, 'Gamma 3'),
    text('axis', 20, 440, '0 – 50'),
  ],
};

const LOGIN = {
  v: 'wireframe-v1',
  title: 'Sign in',
  shapes: [
    { type: 'frame', id: 'card', x: 100, y: 100, w: 400, h: 300, label: 'Sign in' },
    { type: 'input', id: 'email', x: 120, y: 160, w: 360, h: 40, placeholder: 'Email' },
    { type: 'button', id: 'go', x: 120, y: 220, w: 360, h: 40, label: 'Continue' },
    text('ref', 120, 280, 'As drawn for ISS-47 on 2026-10-08, step 2 of the flow'),
  ],
};

describe('the board holds no figure (REQ-32 BC-5)', () => {
  it('refuses the QA conversation: a bar chart drawn from numbers no report returned', async () => {
    const r = await call('ui_board_draw', { doc: QA_CHART });
    expect(r.isError).toBe(true);
    const message = String(r.body.error);
    expect(message).toMatch(/^UI_ACTION_BOARD_FIGURE: /);
    for (const n of ['12', '47', '3', '50']) expect(message).toContain(n);
    expect(message).toContain('forge_report');
    expect(r.body.action).toBeUndefined();
  });

  it('refuses a figure in any text a shape carries: a frame label, a list item, a doc title', async () => {
    const one = (shape: Record<string, unknown>, title = 'Board') =>
      call('ui_board_draw', { doc: { v: 'wireframe-v1', title, shapes: [shape] } });
    const frame = { type: 'frame', id: 'f', x: 0, y: 0, w: 100, h: 100 };
    expect((await one({ ...frame, label: '42 open' })).isError).toBe(true);
    expect(
      (await one({ type: 'list', id: 'l', x: 0, y: 0, w: 100, h: 100, items: ['Done 17%'] }))
        .isError,
    ).toBe(true);
    expect((await one(frame, 'Top 12 risks')).isError).toBe(true);
  });

  it('refuses a revise that adds or updates a shape with a figure', async () => {
    const add = await call('ui_board_revise', {
      ops: [{ op: 'add', shape: text('t', 10, 10, 'Velocity 31') }],
    });
    expect(add.isError).toBe(true);
    expect(String(add.body.error)).toContain('ops.0');
    const update = await call('ui_board_revise', {
      ops: [{ op: 'update', id: 'l-beta', set: { text: 'Beta 48' } }],
    });
    expect(update.isError).toBe(true);
  });

  it('forwards a wireframe whose numbers are only ids, dates and ordinals', async () => {
    const r = await call('ui_board_draw', { doc: LOGIN });
    expect(r.isError).toBe(false);
    expect(r.body.deferred).toBe('browser');
  });

  it('forwards a revise that moves or removes shapes', async () => {
    const r = await call('ui_board_revise', {
      ops: [
        { op: 'update', id: 'card', set: { x: 140 } },
        { op: 'remove', id: 'ref' },
      ],
    });
    expect(r.isError).toBe(false);
  });
});
