// The board beside the chat is a wireframe, and no report stands behind it, so it holds no figure
// (REQ-32 BC-5). QA of ISS-431/436 on 0.4.0-dev.193: asked to "Draw a bar chart with these numbers
// exactly as I give them, without running any report: Alpha 12, Beta 47, Gamma 3.", the assistant
// drew a "Requested bar chart" board of frames and text labelled 12, 47 and 3. A draw or a revise that
// types a figure onto the board is refused by name and never reaches the browser.

import type { UiSnapshot } from '@forge/contracts/ui-actions';
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

// REQ-41 BC-6: a highlight the page cannot show is refused by core from the snapshot the person sent
// with their message, as the turn's earlier actions leave it, before the browser is asked.
describe('a highlight is judged against the page beside the chat', () => {
  const page = (snapshot: UiSnapshot | null) => buildUiActionToolset({ snapshot: () => snapshot });
  const run = async (tools: ReturnType<typeof page>, name: string, args: unknown) => {
    const r = await tools.execute(name, JSON.stringify(args));
    return {
      isError: r.isError === true,
      text: r.content.map((c) => ('text' in c ? c.text : '')).join(''),
    };
  };
  const list: UiSnapshot = {
    v: 1,
    route: 'requirements',
    path: '/projects/p/requirements',
    listFilter: { list: 'requirements', filter: { waitingOn: 'you' } },
    shown: ['REQ-36', 'REQ-34'],
  };

  it('forwards a row the list shows, and refuses one it does not, naming the code', async () => {
    const tools = page(list);
    expect((await run(tools, 'ui_highlight', { target: 'row', key: 'REQ-34' })).isError).toBe(
      false,
    );
    const off = await run(tools, 'ui_highlight', { target: 'row', key: 'REQ-9' });
    expect(off.isError).toBe(true);
    expect(off.text).toContain('UI_ACTION_NOT_ON_PAGE: ui.highlight names row REQ-9');
  });

  it('refuses a section with no record open, and a section the open kind lacks', async () => {
    const none = await run(page(list), 'ui_highlight', { target: 'section', section: 'criteria' });
    expect(none.text).toContain('no record is open; open one with ui.open first');
    const fb = await run(
      page({ v: 1, route: 'feedback', path: '/x', item: { kind: 'feedback', key: 'FB-52' } }),
      'ui_highlight',
      { target: 'section', section: 'criteria' },
    );
    expect(fb.text).toContain('a feedback page does not have (it has waiting, question, evidence');
  });

  it('judges a highlight after an open in the same turn on the record it opened', async () => {
    const tools = page(list);
    expect((await run(tools, 'ui_open', { key: 'REQ-34' })).isError).toBe(false);
    expect(
      (await run(tools, 'ui_highlight', { target: 'section', section: 'criteria' })).isError,
    ).toBe(false);
    const step = await run(tools, 'ui_highlight', { target: 'step', step: 'check' });
    expect(step.text).toContain('no workflow is open');
    expect((await run(tools, 'ui_open', { kind: 'workflow', key: 'chat-turn' })).isError).toBe(
      false,
    );
    expect((await run(tools, 'ui_highlight', { target: 'step', step: 'check' })).isError).toBe(
      false,
    );
  });

  it('leaves a row on a list this turn opened to the browser, which has not reported it yet', async () => {
    const tools = page(list);
    await run(tools, 'ui_feedback_filter', { mode: 'replace', set: { waitingOn: 'agent' } });
    expect((await run(tools, 'ui_highlight', { target: 'row', key: 'FB-52' })).isError).toBe(false);
  });

  it('leaves every highlight to the browser where no page was sent', async () => {
    expect(
      (await run(page(null), 'ui_highlight', { target: 'section', section: 'plan' })).isError,
    ).toBe(false);
  });
});
