// @direct-test-of packages/core/src/beta-port/markers.ts
// @direct-test-of packages/core/src/beta-port/report.ts
// @direct-test-of packages/core/src/schedules/cron.ts

import { ISSUE_STATUSES } from '@forge/contracts/issue-machine';
import { describe, expect, it } from 'vitest';
import { validateCron } from '../schedules/cron.js';
import {
  DEV_TO_BETA_STATUS,
  devLanding,
  firstLineNamesBetaIssue,
  firstLineOf,
  isPortedMarker,
  markerDevKey,
  mirrorTarget,
  owesTry,
  portedComment,
  portedFirstLine,
} from './markers.js';
import { emptyReport, renderReport, reportSaysSomething } from './report.js';

const CUTOFF = new Date('2026-11-03T04:00:00.000Z');
const BETA = { id: '3f1c42a3-1111-4222-8333-944445555666', key: 'ISS-769' };

describe('the ported marker (ISS-923)', () => {
  it('reads the hand ports and its own comment, any case, any key after it', () => {
    expect(isPortedMarker('Ported to forge-dev: ISS-4')).toBe(true);
    expect(isPortedMarker('ported to Forge-Dev as ISS-5, thanks')).toBe(true);
    expect(isPortedMarker(portedComment('SD-12'))).toBe(true);
    expect(markerDevKey('Ported to forge-dev: iss-4')).toBe('ISS-4');
    expect(markerDevKey('ported to forge-dev SD-12 by hand')).toBe('SD-12');
  });

  it('reads no other comment as a port', () => {
    expect(isPortedMarker('Will port to forge-dev tomorrow')).toBe(false);
    expect(isPortedMarker('Ported to forge-beta: ISS-4')).toBe(false);
    expect(isPortedMarker('')).toBe(false);
    expect(markerDevKey('Ported to forge-dev')).toBeNull();
  });
});

describe('a dev first line naming a beta issue', () => {
  it('names it by id, or by key beside forge-beta', () => {
    expect(firstLineNamesBetaIssue(portedFirstLine(BETA.key, BETA.id), BETA)).toBe(true);
    expect(firstLineNamesBetaIssue(`copied from ${BETA.id.toUpperCase()}`, BETA)).toBe(true);
    expect(firstLineNamesBetaIssue('From forge-beta iss-769: the login loop', BETA)).toBe(true);
  });

  it('does not name it by a key alone, by a longer key, or on a later line', () => {
    expect(firstLineNamesBetaIssue('Fixes ISS-769', BETA)).toBe(false);
    expect(firstLineNamesBetaIssue('Ported from forge-beta ISS-7690 (x).', BETA)).toBe(false);
    expect(firstLineNamesBetaIssue('Ported from forge-beta XISS-769.', BETA)).toBe(false);
    const later = `The login loop\nPorted from forge-beta ISS-769 (${BETA.id}).`;
    expect(firstLineNamesBetaIssue(firstLineOf(later), BETA)).toBe(false);
    expect(firstLineOf(null)).toBe('');
  });

  it('opens with the beta key and id', () => {
    expect(portedFirstLine('ISS-1', 'abc')).toBe('Ported from forge-beta ISS-1 (abc).');
  });
});

describe('the status map', () => {
  it('mirrors every status of the ten by its own name, but draft', () => {
    for (const status of ISSUE_STATUSES) {
      expect(DEV_TO_BETA_STATUS[status]).toBe(status === 'draft' ? null : status);
    }
    expect(mirrorTarget('draft')).toBeNull();
    expect(mirrorTarget('awaiting_release')).toBe('awaiting_release');
  });

  it('mirrors no status it does not know', () => {
    expect(mirrorTarget('testing')).toBeNull();
    expect(mirrorTarget('')).toBeNull();
  });
});

describe('the fire report', () => {
  it('caps each list and counts the rest', () => {
    const report = emptyReport(CUTOFF);
    report.ported = Array.from({ length: 23 }, (_, i) => `ISS-${i} → SD-${i}`);
    report.waiting = 4;
    const text = renderReport(report, 20);
    expect(text).toContain('ported (23):');
    expect(text).toContain('  ISS-19 → SD-19');
    expect(text).not.toContain('ISS-20 → SD-20');
    expect(text).toContain('… and 3 more');
    expect(text).toContain('left for the next fire: 4');
    expect(text).toContain('mirrored: none');
  });

  it('says nothing changed only when nothing did', () => {
    const report = emptyReport(CUTOFF);
    report.skipped.push('ISS-1 (named on SD-1)');
    expect(reportSaysSomething(report)).toBe(false);
    report.beforeRuling.push('sid-desk: 1490 (not ported)');
    expect(reportSaysSomething(report)).toBe(false);
    report.noTwin.push('lonely');
    expect(reportSaysSomething(report)).toBe(true);
  });

  it('opens with the cutoff and counts what was filed before the ruling, per project', () => {
    const report = emptyReport(CUTOFF);
    report.beforeRuling.push('adminhub-api: 1490 (not ported)', 'catalog-api: 27 (not ported)');
    const text = renderReport(report);
    expect(text.split('\n')[0]).toBe(
      "cutoff: the owner's ruling beta-issues-are-worked-on-dev, 2026-11-03T04:00:00.000Z",
    );
    expect(text).toContain('before the ruling (2):\n  adminhub-api: 1490 (not ported)');
    expect(renderReport(emptyReport(CUTOFF))).toContain('before the ruling: none');
  });
});

describe('a mirror try', () => {
  const fresh = { lastMirroredStatus: 'open', lastTriedStatus: 'open' };
  const old = { lastMirroredStatus: 'closed', lastTriedStatus: null };

  it('is owed once per dev status under this rule', () => {
    expect(owesTry(fresh, 'open', 'open')).toBeNull();
    expect(owesTry(fresh, 'closed', 'open')).toBe('try');
    expect(
      owesTry({ ...fresh, lastTriedStatus: 'closed' }, 'closed', 'awaiting_release'),
    ).toBeNull();
  });

  it('retries once a status the old rule recorded as mirrored where beta does not stand at it', () => {
    expect(owesTry(old, 'closed', 'in_progress')).toBe('retry-old');
    expect(owesTry(old, 'closed', 'closed')).toBeNull();
    expect(owesTry(old, 'dropped', 'closed')).toBe('try');
    expect(
      owesTry({ lastMirroredStatus: 'draft', lastTriedStatus: null }, 'draft', 'open'),
    ).toBeNull();
    expect(owesTry({ lastMirroredStatus: null, lastTriedStatus: null }, 'open', 'open')).toBe(
      'try',
    );
  });

  it("names where the dev issue's work landed: its landing, else its commit", () => {
    const dev = { key: 'SD-5', mergedLanding: null, mergedCommitSha: null };
    expect(devLanding({ ...dev, mergedLanding: 'https://x.example/a' })).toBe(
      'forge-dev SD-5 at https://x.example/a',
    );
    expect(devLanding({ ...dev, mergedCommitSha: '0123456789abcdef0123' })).toBe(
      'forge-dev SD-5 at commit 0123456789ab',
    );
    expect(devLanding(dev)).toBe('forge-dev SD-5');
  });
});

describe('the minimum interval by kind', () => {
  it('lets a beta port fire every 15 minutes and holds every other kind to the hour', () => {
    expect(validateCron('*/15 * * * *', null, 'beta_port').ok).toBe(true);
    expect(validateCron('*/10 * * * *', null, 'beta_port').ok).toBe(false);
    expect(validateCron('*/15 * * * *', null, 'prompt').ok).toBe(false);
    expect(validateCron('*/15 * * * *').ok).toBe(false);
    expect(validateCron('0 * * * *', null, 'cleanup').ok).toBe(true);
  });
});
