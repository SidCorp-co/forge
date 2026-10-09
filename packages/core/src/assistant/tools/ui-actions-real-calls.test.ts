// The calls the chat model REALLY made (ui-actions-real-calls.ts, read from dev's stored turns, QA of
// dev.219/220, ISS-495), run through the real tool handler and then through the reader the browser
// uses on what core forwards. Lane chat-fixes proved the tools with a scripted model sending the
// shape they were written for; the model sent another, and core's forwarded form was refused by the
// browser's second parse of it ("set: expected array, received object"). Each call is either valid,
// all the way to the page, or refused by name for the one thing wrong with it.

import { parseForwardedUiAction, type UiAction } from '@forge/contracts/ui-actions';
import { REAL_UI_CALLS } from '@forge/contracts/ui-actions-real-calls';
import { describe, expect, it } from 'vitest';
import { buildUiActionToolset } from './ui-actions-tool.js';

describe('the real calls of dev.219 and dev.220', () => {
  for (const [i, fixture] of REAL_UI_CALLS.entries()) {
    const label = `#${i} ${fixture.name} ${JSON.stringify(fixture.input).slice(0, 90)}`;
    it(fixture.expect === 'ok' ? `lands: ${label}` : `is refused by name: ${label}`, async () => {
      const tools = buildUiActionToolset();
      const result = await tools.execute(fixture.name, JSON.stringify(fixture.input));
      const text = result.content.map((c) => ('text' in c ? c.text : '')).join('');
      if (fixture.expect !== 'ok') {
        expect(result.isError, text).toBe(true);
        expect(text).toContain(fixture.expect.refused);
        return;
      }
      expect(result.isError, text).not.toBe(true);
      const forwarded = (JSON.parse(text) as { action: UiAction }).action;
      const read = parseForwardedUiAction(forwarded.name, forwarded.params);
      expect(read.ok, JSON.stringify(read)).toBe(true);
      if (read.ok) expect(read.action).toEqual(forwarded);
    });
  }
});
