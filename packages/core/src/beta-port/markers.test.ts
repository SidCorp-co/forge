// @direct-test-of packages/core/src/beta-port/markers.ts
// @direct-test-of packages/core/src/beta-port/report.ts
// @direct-test-of packages/core/src/schedules/cron.ts
// @direct-test-of packages/core/src/integrations/peer-forge/landing.ts

import { ISSUE_STATUSES } from '@forge/contracts/issue-machine';
import { describe, expect, it } from 'vitest';
import { peerLandingOf } from '../integrations/peer-forge/landing.js';
import { validateCron } from '../schedules/cron.js';
import {
  BETA_PORT_PROGRESS,
  DEV_TO_BETA_STATUS,
  devLanding,
  feedbackSeqOf,
  firstLineNamesBetaIssue,
  firstLineOf,
  isPortedMarker,
  landingMark,
  leftOnBeta,
  markerDevKey,
  mirrorTarget,
  movesBackward,
  owesTry,
  portedComment,
  portedFirstLine,
} from './markers.js';
import { emptyReport, renderReport, reportSaysSomething } from './report.js';

const CUTOFF = new Date('2026-11-03T04:00:00.000Z');
const BETA = { id: '3f1c42a3-1111-4222-8333-944445555666', key: 'ISS-769' };

describe('the ported marker (ISS-923)', () => {
  it('reads a port from a comment that opens with the phrase, by hand or by this sweep', () => {
    expect(isPortedMarker('Ported to forge-dev: ISS-4')).toBe(true);
    expect(isPortedMarker('ported to Forge-Dev as ISS-5, thanks')).toBe(true);
    expect(isPortedMarker(portedComment('SD-12'))).toBe(true);
    expect(markerDevKey('Ported to forge-dev: iss-4')).toBe('ISS-4');
    expect(markerDevKey('ported to forge-dev SD-12 by hand')).toBe('SD-12');
  });

  it('reads no other comment as a port', () => {
    expect(isPortedMarker('Will port to forge-dev tomorrow')).toBe(false);
    expect(isPortedMarker('Ported to forge-beta: ISS-4')).toBe(false);
    expect(isPortedMarker('Ported to forge-devops: ISS-4')).toBe(false);
    expect(isPortedMarker('')).toBe(false);
    expect(markerDevKey('Ported to forge-dev')).toBeNull();
  });
});

describe('a port marker is its comment first line (ISS-1045)', () => {
  const prose =
    "Decision: left for the automatic port | the port posts 'Ported to forge-dev:' here; none after 4 min";

  it('takes the phrase quoted or explained in prose for no marker, and reads no key out of it', () => {
    expect(isPortedMarker(prose)).toBe(false);
    expect(markerDevKey(prose)).toBeNull();
    expect(isPortedMarker('Note: this was ported to forge-dev: ISS-4')).toBe(false);
    expect(isPortedMarker('Plan\nPorted to forge-dev: ISS-4')).toBe(false);
    expect(markerDevKey('Plan\nPorted to forge-dev: ISS-4')).toBeNull();
  });

  it('reads the first non-empty line, so leading blank lines and indentation do not hide a marker', () => {
    expect(isPortedMarker('\n\n  Ported to forge-dev: FB-10\nby hand')).toBe(true);
    expect(markerDevKey('\r\n  Ported to forge-dev: FB-10\r\nby hand')).toBe('FB-10');
  });

  it("reads a first-line marker with no key as a marker with no key, and the sweep's own comment with its key", () => {
    expect(isPortedMarker('Ported to forge-dev\n\nkey to follow')).toBe(true);
    expect(markerDevKey('Ported to forge-dev\n\nkey to follow')).toBeNull();
    expect(markerDevKey('Ported to forge-dev: here')).toBeNull();
    expect(markerDevKey(portedComment('FB-10'))).toBe('FB-10');
    expect(markerDevKey('Ported to forge-dev: FB-10')).toBe('FB-10');
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

describe('the one order of progress (ISS-982)', () => {
  it('never moves a landed beta issue back to a status before landing', () => {
    for (const landed of ['developed', 'testing', 'tested', 'releasing', 'awaiting_release']) {
      for (const back of ['open', 'reopen', 'needs_info', 'on_hold', 'in_progress', 'dropped']) {
        expect(movesBackward(landed, back), `${landed} → ${back}`).toBe(true);
      }
    }
    expect(movesBackward('closed', 'awaiting_release')).toBe(true);
    expect(movesBackward('in_progress', 'open')).toBe(true);
  });

  it('moves forward, and between statuses of one step, as before', () => {
    expect(movesBackward('developed', 'awaiting_release')).toBe(false);
    expect(movesBackward('awaiting_release', 'closed')).toBe(false);
    expect(movesBackward('developed', 'developed')).toBe(false);
    // a park or a drop while work is in flight is no step back
    expect(movesBackward('in_progress', 'needs_info')).toBe(false);
    expect(movesBackward('on_hold', 'dropped')).toBe(false);
    expect(movesBackward('open', 'on_hold')).toBe(false);
  });

  it('places every dev status and holds no move it cannot place', () => {
    for (const status of ISSUE_STATUSES) {
      expect(Number.isInteger(BETA_PORT_PROGRESS[status] ?? 0), status).toBe(true);
    }
    expect(movesBackward('a-status-beta-made-up', 'open')).toBe(false);
  });

  it('leaves an issue in flight or landed on beta, and ports one still waiting', () => {
    expect(leftOnBeta({ status: 'in_progress', marked: false })).toBe('in_progress');
    expect(leftOnBeta({ status: 'developed', marked: null })).toBe('developed');
    expect(leftOnBeta({ status: 'closed', marked: false })).toBe('closed');
    expect(leftOnBeta({ status: 'open', marked: true })).toBe('open, merge-marked');
    for (const waiting of ['open', 'reopen', 'needs_info', 'on_hold', 'confirmed', 'approved']) {
      expect(leftOnBeta({ status: waiting, marked: false }), waiting).toBeNull();
    }
  });

  it('tells a feedback key in a marker from an issue key', () => {
    expect(feedbackSeqOf('FB-12')).toBe(12);
    expect(feedbackSeqOf('fb-3')).toBe(3);
    expect(feedbackSeqOf('ISS-12')).toBeNull();
    expect(markerDevKey(portedComment('FB-7'))).toBe('FB-7');
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
    // an issue left on beta is named every fire and changes nothing
    report.leftOnBeta.push('sidpeak: beta ISS-621 (developed)');
    expect(reportSaysSomething(report)).toBe(false);
    expect(renderReport(report)).toContain(
      'left on beta, in flight or landed there (1):\n  sidpeak: beta ISS-621 (developed)',
    );
    report.held.push('sidpeak: ISS-1 at needs_info: beta ISS-621 keeps developed');
    expect(reportSaysSomething(report)).toBe(true);
    expect(renderReport(report)).toContain(
      'held (1):\n  sidpeak: ISS-1 at needs_info: beta ISS-621 keeps developed',
    );
    report.held.length = 0;
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
  const fresh = { lastMirroredStatus: 'open', lastTriedStatus: 'open', betaReached: 'open' };
  const old = { lastMirroredStatus: 'closed', lastTriedStatus: null, betaReached: null };

  it('is owed once per dev status under this rule', () => {
    expect(owesTry(fresh, 'open', 'open')).toBeNull();
    expect(owesTry(fresh, 'closed', 'open')).toBe('try');
    expect(owesTry({ ...fresh, lastTriedStatus: 'dropped' }, 'dropped', 'open')).toBeNull();
  });

  it('(ISS-1005) retries a close beta has not taken at every fire, while beta stands where the last try left it', () => {
    const held = { ...fresh, lastTriedStatus: 'closed', betaReached: 'awaiting_release' };
    expect(owesTry(held, 'closed', 'awaiting_release')).toBe('retry-close');
    expect(owesTry(held, 'closed', 'closed')).toBeNull();
    // a person moved the beta issue since: it is left as they moved it
    expect(owesTry(held, 'closed', 'reopen')).toBeNull();
    // only a close is retried
    expect(
      owesTry({ ...held, lastTriedStatus: 'on_hold', betaReached: 'open' }, 'on_hold', 'open'),
    ).toBeNull();
  });

  it('retries once a status the old rule recorded as mirrored where beta does not stand at it', () => {
    expect(owesTry(old, 'closed', 'in_progress')).toBe('retry-old');
    expect(owesTry(old, 'closed', 'closed')).toBeNull();
    expect(owesTry(old, 'dropped', 'closed')).toBe('try');
    expect(owesTry({ ...old, lastMirroredStatus: 'draft' }, 'draft', 'open')).toBeNull();
    expect(owesTry({ ...old, lastMirroredStatus: null }, 'open', 'open')).toBe('try');
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

describe("beta's merge mark in its project's landing shape (ISS-923 fix forward)", () => {
  const SHA = 'b7c393812cd5a0f1e2d3c4b5a6978877665544aa';
  const dev = {
    key: 'SD-5',
    mergedLanding: null,
    mergedCommitSha: SHA,
    mergedAt: new Date('2026-11-03T07:45:47.000Z'),
  };
  const git = { shape: 'git', target: 'master', from: 'deploysFrom' } as const;

  it('names the commit and target in git, never a landing', () => {
    const built = landingMark(dev, git);
    expect(built).toMatchObject({
      ok: true,
      mark: { commit: SHA, target: 'master', mergedAt: '2026-11-03T07:45:47.000Z' },
      says: 'its landing recorded as commit b7c393812cd5 on master',
    });
    expect(built.ok && built.mark).not.toHaveProperty('landing');
    expect(built.ok && 'note' in built.mark && built.mark.note).toContain('SD-5');
  });

  it('names the landing outside git, and refuses a git mark with no commit by name', () => {
    const outside = landingMark(
      { ...dev, mergedLanding: 'https://x.example/a' },
      {
        shape: 'outside_git',
      },
    );
    expect(outside).toMatchObject({
      ok: true,
      mark: { landing: 'forge-dev SD-5 at https://x.example/a' },
    });
    expect(outside.ok && outside.mark).not.toHaveProperty('commit');
    const none = landingMark({ ...dev, mergedCommitSha: null }, git);
    expect(none).toEqual({
      ok: false,
      refusal: expect.stringContaining('BETA_PORT_NO_MERGED_COMMIT: SD-5'),
    });
  });

  it('reads the landing from the beta project document: base branch, or deploysFrom where a release promotes into it', () => {
    const doc = (document: unknown) => peerLandingOf({ declared: true, revision: 1, document });
    const source = { type: 'git', git: { defaultBranch: 'dev' } };
    const production = (deploysFrom: string) => ({
      production: { tier: 'production', deploysFrom, deployment: {} },
    });
    expect(doc({ source, environments: {}, promotions: [] })).toEqual({
      ok: true,
      landing: { shape: 'git', target: 'dev', from: 'defaultBranch' },
    });
    expect(
      doc({
        source,
        environments: production('master'),
        promotions: [{ from: 'dev', to: 'master' }],
      }),
    ).toEqual({ ok: true, landing: { shape: 'git', target: 'master', from: 'deploysFrom' } });
    // no promotion reaches it: not release-promoted, the base branch
    expect(doc({ source, environments: production('master'), promotions: [] })).toMatchObject({
      landing: { target: 'dev' },
    });
    for (const type of ['none', 'storefront']) {
      expect(doc({ source: { type } })).toEqual({ ok: true, landing: { shape: 'outside_git' } });
    }
  });

  it('refuses by name a document it cannot read the landing from', () => {
    expect(peerLandingOf({ declared: false, revision: null, document: null })).toMatchObject({
      ok: false,
      code: 'PEER_FORGE_LANDING_UNDECLARED',
    });
    for (const answer of [
      null,
      { declared: true, document: { source: { type: 'svn' } } },
      { declared: true, document: { source: { type: 'git', git: {} } } },
    ]) {
      expect(peerLandingOf(answer)).toMatchObject({
        ok: false,
        code: 'PEER_FORGE_LANDING_UNREADABLE',
      });
    }
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
