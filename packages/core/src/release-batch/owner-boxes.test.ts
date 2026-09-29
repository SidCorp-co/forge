/**
 * Which box may own a release, judged on the rule each clause rests on: one answer per box, in
 * the order an operator fixes them, with the eligible set derived from those answers rather than
 * filtered before them (ISS-1281). The capability shapes are the fixture the runner's own
 * heartbeat test writes, so a field renamed on one side goes red on this one.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  classifyOwnerBox,
  eligibleOwners,
  noOwnerSentence,
  type OwnerBox,
  type OwnerBoxRow,
  ownerBoxClause,
  RELEASE_ROLE,
  readBoxCapabilities,
  readingOf,
} from './owner-boxes.js';

const fixture = JSON.parse(
  readFileSync(new URL('./box-capabilities.fixture.json', import.meta.url), 'utf8'),
) as Record<'draining' | 'open' | 'roleless', unknown>;

const NOW = new Date('2026-09-30T10:00:00.000Z');

function row(over: Partial<OwnerBoxRow> = {}): OwnerBoxRow {
  return {
    deviceId: 'dev-a',
    deviceName: 'box-a',
    status: 'online',
    lastSeenAt: new Date(NOW.getTime() - 5_000),
    limitReason: null,
    rateLimitedUntil: null,
    quarantinedUntil: null,
    provisionStatus: 'ready',
    deviceDisabledAt: null,
    deviceAgentVersion: '0.17.60',
    labels: [],
    capabilities: fixture.open,
    hasMaster: true,
    ...over,
  };
}

describe('readBoxCapabilities, on what the runner sends', () => {
  it('reads an open box that ships the release role', () => {
    expect(readBoxCapabilities(fixture.open)).toEqual({
      releaseRole: true,
      admission: { state: 'open' },
    });
  });

  it('reads a drain with the instant its admission comes back', () => {
    expect(readBoxCapabilities(fixture.draining)).toEqual({
      releaseRole: true,
      admission: {
        state: 'draining',
        cause: 'update 0.17.57 → 0.17.60',
        sinceMs: 1790236800000,
        boundSecs: 7200,
        returnAtMs: 1790236800000 + 7200 * 1000,
      },
    });
  });

  it('reads a box with no admission record as unreported, never as open', () => {
    expect(readBoxCapabilities(fixture.roleless)).toEqual({
      releaseRole: false,
      admission: { state: 'unreported' },
    });
  });

  it('reads a runner older than the field as shipping no release role', () => {
    expect(readBoxCapabilities(null).releaseRole).toBe(false);
    expect(readBoxCapabilities({}).releaseRole).toBe(false);
    expect(readBoxCapabilities({ releaseRole: 'yes' }).releaseRole).toBe(false);
  });

  it('does not read a drain missing its bound as a drain it can date', () => {
    expect(
      readBoxCapabilities({ releaseRole: true, admission: { state: 'draining', cause: 'x' } })
        .admission,
    ).toEqual({ state: 'unreported' });
  });
});

describe('classifyOwnerBox', () => {
  it('lets a live box with a master, the role and an open admission take it', () => {
    expect(classifyOwnerBox(row(), null, NOW).reason).toBeNull();
  });

  it.each([
    ['runner-held', row({ status: 'offline' })],
    ['no-master', row({ hasMaster: false })],
    ['no-release-role', row({ capabilities: fixture.roleless })],
    ['draining', row({ capabilities: fixture.draining })],
  ] as const)('refuses a box for %s', (reason, r) => {
    expect(classifyOwnerBox(r, null, NOW).reason).toBe(reason);
  });

  it('names the first thing an operator fixes when several hold a box', () => {
    const every = row({ status: 'offline', hasMaster: false, capabilities: fixture.draining });
    expect(classifyOwnerBox(every, null, NOW).reason).toBe('runner-held');
    const noMasterDraining = row({ hasMaster: false, capabilities: fixture.draining });
    expect(classifyOwnerBox(noMasterDraining, null, NOW).reason).toBe('no-master');
  });

  it('carries the drain cause and its return instant', () => {
    const box = classifyOwnerBox(row({ capabilities: fixture.draining }), null, NOW);
    expect(box.detail).toBe('update 0.17.57 → 0.17.60');
    expect(box.returnAtMs).toBe(1790236800000 + 7200 * 1000);
  });

  it('marks a box labelled only where the release prefers that label', () => {
    expect(classifyOwnerBox(row({ labels: ['prod'] }), 'prod', NOW).labelled).toBe(true);
    expect(classifyOwnerBox(row({ labels: ['prod'] }), null, NOW).labelled).toBe(false);
    expect(classifyOwnerBox(row({ labels: [] }), 'prod', NOW).labelled).toBe(false);
  });
});

const box = (over: Partial<OwnerBox>): OwnerBox => ({
  deviceId: 'dev-a',
  deviceName: 'box-a',
  labelled: false,
  reason: null,
  detail: null,
  returnAtMs: null,
  ...over,
});

// ISS-1128: a label ranks the boxes; it never removes the only ones there are.
describe('eligibleOwners', () => {
  const plain = box({ deviceId: 'a', deviceName: 'a' });
  const labelled = box({ deviceId: 'b', deviceName: 'b', labelled: true });
  const held = box({ deviceId: 'c', deviceName: 'c', labelled: true, reason: 'no-master' });

  it('offers every able box where no label is preferred', () => {
    expect(eligibleOwners([plain, labelled, held], null)).toEqual({
      eligible: [plain, labelled],
      preferenceMet: true,
    });
  });

  it('narrows to the labelled boxes where one of them is able', () => {
    expect(eligibleOwners([plain, labelled], 'prod')).toEqual({
      eligible: [labelled],
      preferenceMet: true,
    });
  });

  it('falls back to every able box, saying so, where no labelled box is able', () => {
    expect(eligibleOwners([plain, held], 'prod')).toEqual({
      eligible: [plain],
      preferenceMet: false,
    });
  });

  it('offers nothing where no box is able, whatever the label', () => {
    expect(eligibleOwners([held], null).eligible).toEqual([]);
  });
});

describe('the sentence a refused press reads', () => {
  it('gives every box its own clause naming the act that frees it', () => {
    const text = noOwnerSentence(
      [
        box({ deviceName: 'held', reason: 'runner-held', detail: 'stale' }),
        box({ deviceName: 'masterless', reason: 'no-master' }),
        box({ deviceName: 'old', reason: 'no-release-role' }),
        box({
          deviceName: 'updating',
          reason: 'draining',
          detail: 'update',
          returnAtMs: Date.parse('2026-09-30T12:00:00.000Z'),
        }),
      ].map(readingOf),
    );
    expect(text).toContain('`held`: its runner cannot take work (stale)');
    expect(text).toContain('`masterless`: no master pane of this project is running there');
    expect(text).toContain(`\`old\`: its heartbeat reports no \`${RELEASE_ROLE}\` role`);
    expect(text).toContain(
      '`updating`: draining for update, so it admits no run until 2026-09-30T12:00:00.000Z',
    );
    expect(text).toContain('no issue was claimed');
  });

  it('says no box serves the project rather than listing nothing', () => {
    expect(noOwnerSentence([])).toContain('no box serves this project');
  });

  it('calls an able box able', () => {
    expect(ownerBoxClause(readingOf(box({ deviceName: 'ok' })))).toBe('`ok`: able to take it');
  });
});
