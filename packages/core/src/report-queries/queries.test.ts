import type { DeliveryForecast } from '@forge/contracts/forecast';
import type { ProjectStatus, StatusRequirement } from '@forge/contracts/project-status';
import { ReportFrameSchema } from '@forge/contracts/report-queries';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const status = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('../project-status/index.js', () => ({
  readProjectStatus: status.read,
  statusViewerOf: () => ({ userId: 'u', agency: 'human', canWrite: true }),
}));

const { progressByRequirement } = await import('./progress-by-requirement.js');
const { roadmapEta, etaOf } = await import('./roadmap-eta.js');

const ctx = { projectId: 'p', now: new Date('2026-10-08T09:00:00.000Z'), viewer: {} as never };

const req = (key: string, state: StatusRequirement['state'], proven: number, total: number) =>
  ({
    key,
    title: `Title ${key}`,
    state,
    criteria: { proven, total },
    progress: { total: 6, shipped: 3, awaitingRelease: 2, toDo: 1 },
    delivery: null,
  }) as unknown as StatusRequirement;

const stamp = { label: 'forecast', asOf: '2026-10-08T09:00:00.000Z' };
const span = {
  p50At: '2026-10-12T00:00:00.000Z',
  p85At: '2026-10-20T00:00:00.000Z',
  p50Minutes: 1,
  p85Minutes: 2,
};
const delivery = (over: Partial<DeliveryForecast>) =>
  ({
    ...stamp,
    landing: { kind: 'landed', landedAt: null, ...stamp },
    release: null,
    inHands: null,
    shipped: null,
    ...over,
  }) as unknown as DeliveryForecast;

beforeEach(() => status.read.mockReset());

describe('progress-by-requirement', () => {
  beforeEach(() => {
    status.read.mockResolvedValue({
      requirements: { items: [req('REQ-1', 'in_delivery', 2, 5), req('REQ-2', 'agreed', 0, 3)] },
    } as unknown as ProjectStatus);
  });

  it('lays each requirement out as one row of the declared fields, the figures the status read decided', async () => {
    const frame = await progressByRequirement.run(ctx, {});
    expect(ReportFrameSchema.safeParse(frame).success).toBe(true);
    expect(frame.fields.map((f) => f.name)).toEqual(
      progressByRequirement.descriptor.output.map((f) => f.name),
    );
    expect(frame.rows[0]).toEqual({
      key: 'REQ-1',
      title: 'Title REQ-1',
      state: 'in_delivery',
      criteriaProven: 2,
      criteriaTotal: 5,
      shipped: 3,
      awaitingRelease: 2,
      toDo: 1,
    });
    expect(frame.rows).toHaveLength(2);
  });

  it('keeps only the requested state', async () => {
    const frame = await progressByRequirement.run(ctx, { state: 'agreed' });
    expect(frame.rows.map((r) => r.key)).toEqual(['REQ-2']);
  });

  it('answers an empty frame, not an error, where no requirement is on the line', async () => {
    status.read.mockResolvedValue({ requirements: { items: [] } } as unknown as ProjectStatus);
    const frame = await progressByRequirement.run(ctx, {});
    expect(frame.rows).toEqual([]);
    expect(ReportFrameSchema.safeParse(frame).success).toBe(true);
  });

  it('declares what it reads', () => {
    expect(progressByRequirement.reads).toEqual(['project-status/read.ts:readProjectStatus']);
  });
});

describe('roadmap-eta', () => {
  it('says the range only where the forecast holds one, else why it holds none', () => {
    expect(etaOf(null)).toEqual({ p50At: null, p85At: null, basis: 'no open work' });
    expect(etaOf(delivery({ inHands: span }))).toEqual({
      p50At: span.p50At,
      p85At: span.p85At,
      basis: 'forecast',
    });
    expect(
      etaOf(
        delivery({ shipped: { version: '1.0.0', at: '2026-10-01T00:00:00.000Z' }, inHands: span }),
      ),
    ).toMatchObject({
      p50At: null,
      basis: 'shipped',
    });
    expect(
      etaOf(delivery({ release: { kind: 'person', who: 'Ana', act: 'cut the release' } as never }))
        .basis,
    ).toBe('waits on Ana to cut the release');
    expect(
      etaOf(
        delivery({ landing: { kind: 'paused', who: 'You', act: 'approve', ...stamp } as never }),
      ).basis,
    ).toBe('waits on You to approve');
    expect(
      etaOf(
        delivery({ landing: { kind: 'not_enough_history', n: 1, floor: 5, ...stamp } as never }),
      ).basis,
    ).toBe('not enough history to forecast');
    expect(
      etaOf(delivery({ landing: { kind: 'ended', status: 'dropped', ...stamp } as never })).basis,
    ).toBe('ended: dropped');
    expect(etaOf(delivery({})).basis).toBe('landed, awaiting release');
  });

  it('lists Now, Next and Later in order, and filters by lane', async () => {
    const item = (key: string, state: StatusRequirement['state'], d: DeliveryForecast | null) => ({
      key,
      title: key,
      state,
      delivery: d,
      deferral: null,
    });
    status.read.mockResolvedValue({
      roadmap: {
        now: [item('REQ-1', 'in_delivery', delivery({ inHands: span }))],
        next: [item('REQ-2', 'agreed', null)],
        later: [item('REQ-3', 'draft', null)],
      },
    } as unknown as ProjectStatus);
    const all = await roadmapEta.run(ctx, {});
    expect(ReportFrameSchema.safeParse(all).success).toBe(true);
    expect(all.rows.map((r) => `${r.lane}:${r.key}`)).toEqual([
      'now:REQ-1',
      'next:REQ-2',
      'later:REQ-3',
    ]);
    expect(all.rows[0]).toMatchObject({ p50At: span.p50At, p85At: span.p85At });
    const later = await roadmapEta.run(ctx, { lane: 'later' });
    expect(later.rows.map((r) => r.key)).toEqual(['REQ-3']);
  });

  it('declares what it reads', () => {
    expect(roadmapEta.reads).toContain('project-status/read.ts:readProjectStatus');
    expect(roadmapEta.reads).toContain('forecast/scope.ts:readForecastLine');
  });
});
