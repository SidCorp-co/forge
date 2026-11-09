// @direct-test-of packages/core/src/pipeline/wedge.ts
// The bell's line for stuck work, as a person reads it (REQ-12 BC-6, ISS-1184): forge-dev's bell read
// "Pipeline wedge: claim hop miss on session", the detector's own vocabulary. Every hop and entity a
// wedge names reads as plain words; the hop, the entity's raw id and the detector's labels stay in the
// log, never on the row.
import { describe, expect, it } from 'vitest';
import { WEDGE_ENTITIES, WEDGE_HOPS, wedgeBody, wedgeTitle } from './wedge-words.js';

const JARGON = /wedge|hop|miss|claim|heartbeat|dispatch|\back\b|capacity|WHERE|WHY|WHAT/i;

describe('a stuck-work notice in plain words (ISS-1184)', () => {
  it('names the session forge-dev showed as jargon in plain words', () => {
    expect(wedgeTitle('claim', 'session')).toBe('An agent session was never picked up by a machine');
  });

  it('reads every hop and entity without the detector’s words', () => {
    for (const hop of WEDGE_HOPS) {
      for (const entity of WEDGE_ENTITIES) {
        const title = wedgeTitle(hop, entity);
        expect(title, `${hop} × ${entity}`).not.toMatch(JARGON);
        expect(title.split(' ').length, `${hop} × ${entity}: a row line is at most 12 words`).toBeLessThanOrEqual(12);
      }
    }
  });

  it('says what was seen and what to do, never the raw id or the WHERE/WHY/WHAT labels', () => {
    const body = wedgeBody({
      reason: 'no worker claimed the session within the queue timeout',
      action: 'Check that an online runner is bound to this project.',
    });
    expect(body).toBe(
      'No worker claimed the session within the queue timeout.\nNext: Check that an online runner is bound to this project.',
    );
    expect(body).not.toMatch(/WHERE|WHY|WHAT/);
  });
});
