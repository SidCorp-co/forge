// A widget session token carries a visitor's chat and a status link token what they filed: both are
// redacted by their prefix wherever they turn up, the status route's path included. A site key is
// public — the page embeds it — and is kept.

import { describe, expect, it } from 'vitest';
import { containsSecret, scrubLogText } from './index.js';

const session = `fw_sess_${'Ab9_-'.repeat(8)}xyz`;
const status = `fw_stat_${'Zq0-_'.repeat(8)}abc`;

describe('a widget token', () => {
  it.each([
    ['a session token in a header line', `authorization: Bearer ${session}`],
    ['a status token in a request path', `GET /api/widget/status/${status} 200`],
    ['a status token cut off', `link ${status.slice(0, 20)}`],
  ])('is redacted as %s', (_where, text) => {
    expect(scrubLogText(text)).not.toMatch(/fw_(sess|stat)_/);
    expect(containsSecret(text)).toBe(true);
  });

  it('keeps a site key, which every page embedding the widget shows', () => {
    const text = `GET /api/widget/fw_site_${'k'.repeat(32)}/config 200`;
    expect(scrubLogText(text)).toBe(text);
  });
});
