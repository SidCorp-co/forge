// @direct-test-of packages/core/src/beta-port/markers.ts
// @direct-test-of packages/core/src/beta-port/report.ts
// @direct-test-of packages/core/src/schedules/cron.ts

import { ISSUE_STATUSES } from '@forge/contracts/issue-machine';
import { describe, expect, it } from 'vitest';
import { validateCron } from '../schedules/cron.js';
import {
  DEV_TO_BETA_STATUS,
  firstLineNamesBetaIssue,
  firstLineOf,
  isPortedMarker,
  markerDevKey,
  mirrorTarget,
  portedComment,
  portedFirstLine,
} from './markers.js';
import { emptyReport, renderReport, reportSaysSomething } from './report.js';

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
    const report = emptyReport();
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
    const report = emptyReport();
    report.skipped.push('ISS-1 (named on SD-1)');
    expect(reportSaysSomething(report)).toBe(false);
    report.noTwin.push('lonely');
    expect(reportSaysSomething(report)).toBe(true);
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
