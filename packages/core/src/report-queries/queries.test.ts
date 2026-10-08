import type { DeliveryForecast } from '@forge/contracts/forecast';
import type { ProjectStatus, StatusRequirement } from '@forge/contracts/project-status';
import { ReportFrameSchema } from '@forge/contracts/report-queries';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const status = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('../project-status/index.js', () => ({
  readProjectStatus: status.read,
  statusViewerOf: () => ({ userId: 'u', agency: 'human', canWrite: true }),
}));
const list = vi.hoisted(() => ({ rows: vi.fn(), forecasts: vi.fn() }));
vi.mock('../requirements/index.js', () => ({ listRequirementsAs: list.rows }));
vi.mock('../forecast/index.js', () => ({ readRequirementForecasts: list.forecasts }));

const { progressByRequirement } = await import('./progress-by-requirement.js');
const { roadmapEta, etaOf } = await import('./roadmap-eta.js');

const ctx = { projectId: 'p', now: new Date('2026-10-08T09:00:00.000Z'), viewer: {} as never };

const req = (key: string, state: StatusRequirement['state'], proven: number, total: number) => ({
  key,
  title: `Title ${key}`,
  standing: { state },
  delivery: { criteriaCoverage: { passing: proven, criteria: total } },
});
const scope = (key: string, d: DeliveryForecast | null = null) => ({
  key,
  progress: { total: 6, shipped: 3, awaitingRelease: 2, toDo: 1 },
  delivery: d,
});

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

beforeEach(() => {
  status.read.mockReset();
  list.rows.mockReset();
  list.forecasts.mockReset();
});

describe('progress-by-requirement', () => {
  const answer = (rows: unknown[], scopes: unknown[]) => {
    list.rows.mockResolvedValue(rows);
    list.forecasts.mockResolvedValue({ requirements: scopes });
  };
  beforeEach(() => {
    answer(
      [req('REQ-2', 'agreed', 0, 3), req('REQ-1', 'in_delivery', 2, 5)],
      [scope('REQ-1'), scope('REQ-2')],
    );
  });

  it('lays each requirement of the list out as one row, the figures its two reads decided', async () => {
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
      lane: 'now',
      p50At: null,
      p85At: null,
      basis: 'no forecast: nothing is linked to it yet',
    });
    expect(frame.rows[1]).toMatchObject({ key: 'REQ-2', lane: 'next' });
    expect(frame.rows).toHaveLength(2);
    expect(list.forecasts).toHaveBeenCalledWith('p', ctx.viewer, ctx.now);
  });

  it('carries the Later lane and the rows off the roadmap, in lane order, soonest first', async () => {
    const soon = delivery({ inHands: { ...span, p50At: '2026-10-09T00:00:00.000Z' } as never });
    answer(
      [
        req('REQ-5', 'dropped', 0, 0),
        req('REQ-4', 'accepted', 1, 1),
        req('REQ-3', 'draft', 0, 0),
        req('REQ-2', 'in_delivery', 0, 2),
        req('REQ-1', 'in_delivery', 0, 2),
      ],
      [
        scope('REQ-1', delivery({ inHands: span as never })),
        scope('REQ-2', soon),
        scope('REQ-3'),
        scope('REQ-4'),
      ],
    );
    const frame = await progressByRequirement.run(ctx, {});
    expect(frame.rows.map((r) => [r.key, r.lane])).toEqual([
      ['REQ-2', 'now'],
      ['REQ-1', 'now'],
      ['REQ-3', 'later'],
      ['REQ-4', null],
      ['REQ-5', null],
    ]);
    expect(frame.rows.at(-1)).toMatchObject({
      p50At: null,
      basis: 'no forecast: dropped',
      shipped: 0,
      toDo: 0,
    });
  });

  it("carries each requirement's dates as the list's ETA cell reads them, with the basis", async () => {
    answer(
      [req('REQ-1', 'in_delivery', 2, 5)],
      [scope('REQ-1', delivery({ inHands: { ...span, ...stamp } as never }))],
    );
    const [row] = (await progressByRequirement.run(ctx, {})).rows;
    expect(row).toMatchObject({ lane: 'now', p50At: span.p50At, p85At: span.p85At });
    expect(row?.basis).toMatch(/^in people's hands/);
  });

  it('keeps only the requested state', async () => {
    const frame = await progressByRequirement.run(ctx, { state: 'agreed' });
    expect(frame.rows.map((r) => r.key)).toEqual(['REQ-2']);
  });

  it('answers an empty frame, not an error, where the project holds no requirement', async () => {
    answer([], []);
    const frame = await progressByRequirement.run(ctx, {});
    expect(frame.rows).toEqual([]);
    expect(ReportFrameSchema.safeParse(frame).success).toBe(true);
  });

  it('declares what it reads: the two reads the Requirements list reads', () => {
    expect(progressByRequirement.reads).toEqual([
      'requirements:listRequirementsAs',
      'forecast/scope.ts:readRequirementForecasts',
    ]);
  });
});

describe('roadmap-eta', () => {
  const range = {
    kind: 'forecast',
    ...stamp,
    ...span,
    ahead: 3,
    aheadKeys: ['ISS-1', 'ISS-2'],
    waitsOn: ['ISS-2'],
    basis: { n: 21, windowDays: 60 },
  } as never;
  const person = { kind: 'person', who: 'Ana', act: 'cut the release' } as never;

  it('says the range only where the forecast holds one, else "no forecast" and why', () => {
    expect(etaOf(null)).toEqual({
      p50At: null,
      p85At: null,
      basis: 'no forecast: nothing is linked to it yet',
    });
    expect(
      etaOf(
        delivery({
          landing: range,
          inHands: { ...span, p50At: 'h50', p85At: 'h85' } as never,
          release: { kind: 'automatic', basis: { n: 9 } } as never,
        }),
      ),
    ).toEqual({
      p50At: 'h50',
      p85At: 'h85',
      basis:
        "in people's hands; 3 ahead (ISS-1, ISS-2, …); waits on ISS-2 to land first; read from 21 issues landed in the last 60 days; release lag read from 9 releases",
    });
    expect(
      etaOf(
        delivery({ shipped: { version: '1.0.0', at: '2026-10-01T00:00:00.000Z' }, inHands: span }),
      ),
    ).toEqual({ p50At: null, p85At: null, basis: 'shipped in 1.0.0 (2026-10-01T00:00:00.000Z)' });
    expect(etaOf(delivery({ release: person })).basis).toBe(
      'no forecast: landed, waits on Ana to cut the release',
    );
    expect(
      etaOf(
        delivery({ landing: { kind: 'paused', who: 'You', act: 'approve', ...stamp } as never }),
      ).basis,
    ).toBe('no forecast: waits on You to approve');
    expect(
      etaOf(
        delivery({ landing: { kind: 'not_enough_history', n: 1, floor: 5, ...stamp } as never }),
      ).basis,
    ).toBe('no forecast: not enough history, 1 of 5 landed issues');
    expect(
      etaOf(delivery({ landing: { kind: 'ended', status: 'dropped', ...stamp } as never })).basis,
    ).toBe('no forecast: ended (dropped)');
    expect(etaOf(delivery({})).basis).toBe('no forecast: landed, awaiting release');
  });

  it('gives the landing range where a person releases, as the list shows it, and names the person', () => {
    expect(etaOf(delivery({ landing: range, release: person }))).toEqual({
      p50At: span.p50At,
      p85At: span.p85At,
      basis:
        'lands by then; then Ana to cut the release; 3 ahead (ISS-1, ISS-2, …); waits on ISS-2 to land first; read from 21 issues landed in the last 60 days',
    });
    expect(
      etaOf(
        delivery({
          landing: range,
          release: { kind: 'not_enough_history', n: 2, floor: 10 } as never,
        }),
      ).basis,
    ).toMatch(/^lands by then; release not forecast: 2 of 10 releases on record/);
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
