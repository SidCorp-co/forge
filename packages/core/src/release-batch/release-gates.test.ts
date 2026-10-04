import { describe, expect, it } from 'vitest';
import { REMEDY_COST, type ReleaseBlocker, type ReleaseReasonCode } from './blocker-sentences.js';
import { gateView, gateViews } from './release-gates.js';

const CODES = Object.keys(REMEDY_COST) as ReleaseReasonCode[];

const blocker = (code: ReleaseReasonCode, details?: Record<string, unknown>): ReleaseBlocker => ({
  code: code as ReleaseBlocker['code'],
  httpStatus: 409,
  message: `FULL ${code}: set it with PUT /api/projects/:id/config, see \`Settings → Runners\``,
  evaluated: true,
  ...(details ? { details } : {}),
});

describe('a gate reads as a sentence', () => {
  it('has a title and a sentence for every code a release can be refused with', () => {
    expect(CODES.length).toBeGreaterThan(15);
    for (const code of CODES) {
      const v = gateView(blocker(code), 'blocker');
      expect(v.title, code).not.toBe('');
      expect(v.sentence, code).not.toBe('');
    }
  });

  it('keeps the code, the API route, a config hint and a backtick off the sentence', () => {
    for (const code of CODES) {
      const { sentence, title } = gateView(
        blocker(code, { waits: [], held: [], displayIds: ['ISS-9'] }),
        'blocker',
      );
      for (const text of [sentence, title]) {
        expect(text, code).not.toMatch(/[A-Z]{3,}_[A-Z_]{3,}/);
        expect(text, code).not.toMatch(/\/api\/|PUT |POST |`/);
      }
    }
  });

  it('carries the full message and the code behind the sentence, for the tooltip', () => {
    const v = gateView(blocker('NO_RELEASE_GATE'), 'blocker');
    expect(v.code).toBe('NO_RELEASE_GATE');
    expect(v.detail).toContain('PUT /api/projects/:id/config');
    expect(v.sentence).not.toContain('PUT');
  });

  it('names the issue, the contract, the version needed and what the provider serves', () => {
    const v = gateView(
      blocker('CONTRACT_PROVIDER_NOT_LIVE', {
        waits: [
          {
            issueId: 'x',
            issue: 'ISS-12',
            contract: 'clinic-crm/patient-lookup',
            needed: '2.1',
            live: '1.4',
          },
          {
            issueId: 'y',
            issue: 'ISS-13',
            contract: 'clinic-crm/wards',
            needed: '1.0',
            live: null,
          },
        ],
      }),
      'blocker',
    );
    expect(v.title).toBe('Provider not live yet');
    expect(v.sentence).toContain('ISS-12 waits on clinic-crm/patient-lookup 2.1 or later');
    expect(v.sentence).toContain('serves 1.4');
    expect(v.sentence).toContain('serves no version Forge could read');
    expect(v.issues).toEqual(['ISS-12', 'ISS-13']);
  });

  it('names the held issues and the criterion each still owes', () => {
    const v = gateView(
      blocker('RELEASE_CRITERIA_UNEARNED', {
        held: [
          { issueId: 'x', displayId: 'ISS-4', criteria: [2, 3] },
          { issueId: 'y', displayId: 'ISS-5', criteria: [1] },
        ],
      }),
      'blocker',
    );
    expect(v.sentence).toContain('ISS-4 owes criterion 2, 3; ISS-5 owes criterion 1');
  });

  it('lists blockers before warnings and marks each kind', () => {
    const warning = {
      code: 'RELEASE_RUNNER_PREFERENCE_UNMET' as const,
      message: 'long text',
    };
    const views = gateViews([blocker('BATCH_IN_FLIGHT')], [warning]);
    expect(views.map((v) => v.kind)).toEqual(['blocker', 'warning']);
  });

  it('says how many issues a count-only refusal is about when no ids were named', () => {
    const v = gateView(blocker('RELEASE_RECORD_MISSING', { issueIds: ['a', 'b'] }), 'blocker');
    expect(v.sentence).toContain('2 issues have no release note');
  });
});
