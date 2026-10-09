import type { FastLaneSettings } from '@forge/contracts/fast-lane';
import { describe, expect, it } from 'vitest';
import type { ApprovedPreview } from './ports.js';
import {
  causesSaid,
  deployRangeRefusal,
  deployTargetsRefusal,
  fastMergeRefusal,
  issueLaneOf,
} from './rules.js';

/** Forge's own declaration, as docs/proposals/live-preview.md writes it. */
const FORGE: FastLaneSettings = {
  paths: ['packages/web-v2/src/**', 'packages/web-v2/public/**'],
  kernel: ['packages/core/**', 'packages/contracts/**', 'packages/runner/**'],
  deployTargets: ['web'],
};
const PATCH = 'c'.repeat(40);
const WEB = 'packages/web-v2/src/features/issues/approve-button.tsx';
const KERNEL = 'packages/core/src/issues/merge-check.ts';

const approved = (over: Partial<ApprovedPreview> = {}): ApprovedPreview => ({
  previewId: '00000000-0000-4000-8000-000000000001',
  patchId: PATCH,
  files: [WEB],
  approvedBy: '00000000-0000-4000-8000-000000000002',
  approvedAt: '2026-10-09T10:00:00.000Z',
  ...over,
});

const report = (paths: string[], patchId: string | undefined = PATCH) => ({
  head: 'a'.repeat(40),
  patchId,
  touched: paths.map((path) => ({ path, change: 'changed' as const })),
});

describe('a fast-lane merge check stands only for the change a person approved (BC-7)', () => {
  const at = (over: Partial<Parameters<typeof fastMergeRefusal>[0]> = {}) =>
    fastMergeRefusal({
      issueRef: 'ISS-9',
      report: report([WEB]),
      settings: FORGE,
      approval: { approved: approved() },
      ...over,
    });

  it('takes the approved web change whose patch it checked', () => {
    expect(at()).toBeNull();
  });

  it('refuses a project that declares no fast lane', () => {
    expect(at({ settings: null })?.code).toBe('FAST_LANE_UNDECLARED');
  });

  it('refuses an issue no preview of which was approved, naming the issue', () => {
    const out = at({ approval: { approved: null } });
    expect(out?.code).toBe('FAST_LANE_NOT_APPROVED');
    expect(out?.detail).toContain('ISS-9 has no approved live preview');
  });

  it('refuses where no previews are served at all, saying so rather than "not yet approved"', () => {
    const out = at({ approval: { unread: 'this core serves no live previews' } });
    expect(out?.code).toBe('FAST_LANE_NOT_APPROVED');
    expect(out?.detail).toContain('serves no live previews');
  });

  it('refuses a change whose patch moved after approval, naming both patches', () => {
    const out = at({ report: report([WEB], 'd'.repeat(40)) });
    expect(out?.code).toBe('FAST_LANE_CHANGED_SINCE_APPROVAL');
    expect(out?.detail).toContain(PATCH);
    expect(out?.detail).toContain('d'.repeat(40));
  });

  it('refuses a change touching the kernel even when it was approved (BC-8), naming file and glob', () => {
    const out = at({ report: report([WEB, KERNEL]) });
    expect(out?.code).toBe('FAST_LANE_NOT_ELIGIBLE');
    expect(out?.detail).toContain(`${KERNEL} (kernel: \`packages/core/**\`)`);
  });

  it('refuses a migration, a permission and a security file inside the web paths', () => {
    for (const file of [
      'packages/web-v2/src/db/migrations/0001.sql',
      'packages/web-v2/src/features/permissions/can.ts',
      'packages/web-v2/src/middleware.ts',
    ]) {
      expect(at({ report: report([file]) })?.code).toBe('FAST_LANE_NOT_ELIGIBLE');
    }
  });
});

describe('the lane an issue reads (BC-8)', () => {
  it('is fast for an approved web change', () => {
    const lane = issueLaneOf({
      issueRef: 'ISS-9',
      settings: FORGE,
      approval: { approved: approved() },
    });
    expect(lane.lane).toBe('fast');
    expect(lane.refusal).toBeNull();
  });

  it('is full with the file and rule named for an approved kernel change', () => {
    const lane = issueLaneOf({
      issueRef: 'ISS-9',
      settings: FORGE,
      approval: { approved: approved({ files: [WEB, KERNEL] }) },
    });
    expect(lane.lane).toBe('full');
    expect(lane.decision).toEqual({
      lane: 'full',
      causes: [{ file: KERNEL, area: 'kernel', glob: 'packages/core/**' }],
    });
    expect(lane.refusal?.code).toBe('FAST_LANE_NOT_ELIGIBLE');
  });

  it('is full, saying why, with nothing approved or nothing declared', () => {
    expect(
      issueLaneOf({ issueRef: 'ISS-9', settings: FORGE, approval: { approved: null } }).refusal
        ?.code,
    ).toBe('FAST_LANE_NOT_APPROVED');
    expect(
      issueLaneOf({ issueRef: 'ISS-9', settings: null, approval: { approved: approved() } }).refusal
        ?.code,
    ).toBe('FAST_LANE_UNDECLARED');
  });
});

describe('a web-only deploy (BC-7)', () => {
  it('names only declared targets the binding holds', () => {
    expect(
      deployTargetsRefusal({ settings: FORGE, labels: ['web'], bound: ['web', 'core'] }),
    ).toBeNull();
    expect(
      deployTargetsRefusal({ settings: FORGE, labels: ['core'], bound: ['web', 'core'] })?.detail,
    ).toContain('"core" is not among `fastLane.deployTargets`');
    expect(
      deployTargetsRefusal({ settings: FORGE, labels: ['web'], bound: ['frontend'] })?.detail,
    ).toContain('holds no target labelled "web"');
    expect(deployTargetsRefusal({ settings: null, labels: ['web'], bound: ['web'] })?.code).toBe(
      'FAST_LANE_UNDECLARED',
    );
  });

  const range = (commits: { sha: string; files: string[] }[]) =>
    deployRangeRefusal({
      settings: FORGE,
      label: 'web',
      served: '1'.repeat(40),
      head: '2'.repeat(40),
      commits,
    });

  it('ships a range whose every commit is fast, passing over one that changes nothing', () => {
    expect(
      range([
        { sha: '3'.repeat(40), files: [WEB] },
        { sha: '4'.repeat(40), files: [] },
      ]),
    ).toBeNull();
  });

  it('refuses a range holding one kernel commit, naming that commit, file and rule', () => {
    const out = range([
      { sha: '3'.repeat(40), files: [WEB] },
      { sha: '5'.repeat(40), files: [KERNEL] },
    ]);
    expect(out?.code).toBe('FAST_LANE_NOT_ELIGIBLE');
    expect(out?.detail).toContain(`${'5'.repeat(12)}: ${KERNEL} (kernel: \`packages/core/**\`)`);
    expect(out?.detail).toContain('1 of its 2 commit(s) are not fast');
    expect(out?.detail).not.toContain('3'.repeat(12));
  });
});

describe('what a refusal says about each cause', () => {
  it('counts what it does not spell out', () => {
    const causes = Array.from({ length: 10 }, (_, i) => ({
      file: `packages/core/${i}.ts`,
      area: 'kernel' as const,
      glob: 'packages/core/**',
    }));
    expect(causesSaid(causes)).toMatch(/; \+2 more$/);
    expect(causesSaid([{ file: 'docs/a.md', area: 'outside-fast-paths', glob: null }])).toContain(
      'outside `fastLane.paths`',
    );
  });
});
