/**
 * ISS-12 — what a project is serving is its production environment's state: the deployment
 * record and each runtime probe production declares. The state reader is stubbed: what is under
 * test is which reading each state becomes, and `environment-state.test.ts` owns the state.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { production, projectDoc, sourceProbe } from '../project-config/release-path.fixture.js';
import type { EnvironmentState, ProjectDocument } from '../project-config/schema.js';

const readDocument = vi.fn(
  async (): Promise<{ revision: number; document: ProjectDocument } | null> => null,
);
const readState = vi.fn(async (..._a: unknown[]): Promise<EnvironmentState> => {
  throw new Error('no state stubbed');
});
vi.mock('../project-config/service.js', () => ({
  readProjectDocument: () => readDocument(),
}));
vi.mock('../project-config/environment-state-read.js', () => ({
  readEnvironmentState: (...a: unknown[]) => readState(...a),
}));

const { readServingNow, servedClause, servedCommits } = await import('./serving-reading.js');

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const SERVED = '0d98a6be6d9680b967d3f16542eadd25d02602cb';
const OTHER = 'da74b598bcae5a53a1c0f2b9e3d7a41f6c8b2d90';
const FROZEN = new Date('2026-09-26T23:55:00.000Z');
const now = () => FROZEN;
const PROBE = 'https://api.example.com/version';

const deployment = {
  id: 'dep-1',
  provider: 'coolify' as const,
  status: 'succeeded' as const,
  at: '2026-09-26T23:50:00Z',
};
const RECORD = 'coolify deployment dep-1 of environment `beta` (succeeded, 2026-09-26T23:50:00Z)';

const recorded = (over: Record<string, unknown> = {}) =>
  ({
    environment: 'beta',
    state: 'deployed',
    evidence: 'deployment-record',
    deployment,
    artifact: null,
    source: { kind: 'revision', revision: SERVED },
    ...over,
  }) as EnvironmentState;

beforeEach(() => {
  vi.clearAllMocks();
  readDocument.mockResolvedValue({
    revision: 3,
    document: projectDoc({
      environments: {
        beta: production({ verification: { runtime: [sourceProbe(PROBE)] } }),
      },
    }),
  });
});

describe('readServingNow', () => {
  it('reads the commit production is serving from its probe and its deployment record', async () => {
    readState.mockResolvedValue(
      recorded({
        evidence: 'runtime-confirmed',
        probes: [{ url: PROBE, identifies: 'source', status: 'confirmed', observed: SERVED }],
      }),
    );

    expect(await readServingNow(PROJECT_ID, now)).toEqual({
      kind: 'serving',
      served: [
        { commit: SERVED, where: PROBE },
        { commit: SERVED, where: RECORD },
      ],
      unread: [],
      readAt: FROZEN.toISOString(),
    });
    expect(readState).toHaveBeenCalledWith(
      PROJECT_ID,
      expect.anything(),
      expect.objectContaining({ name: 'beta' }),
    );
  });

  it('reads both commits where the probe and the record disagree, not one of them', async () => {
    readState.mockResolvedValue(
      recorded({
        evidence: 'runtime-mismatch',
        probes: [
          {
            url: PROBE,
            identifies: 'source',
            status: 'mismatch',
            observed: OTHER,
            expected: SERVED,
          },
        ],
      }),
    );

    const reading = await readServingNow(PROJECT_ID, now);
    expect(servedCommits(reading)).toEqual([OTHER, SERVED]);
  });

  it('keeps the record commit and names the probe that answered nothing', async () => {
    readState.mockResolvedValue(
      recorded({
        evidence: 'runtime-unreachable',
        probes: [
          {
            url: PROBE,
            identifies: 'source',
            status: 'unreachable',
            error: 'ENOTFOUND api.example.com',
          },
        ],
      }),
    );

    const reading = await readServingNow(PROJECT_ID, now);
    expect(reading).toMatchObject({
      kind: 'serving',
      served: [{ commit: SERVED, where: RECORD }],
      unread: ['ENOTFOUND api.example.com'],
    });
  });

  it('reads a deployment still running as naming nothing served', async () => {
    readState.mockResolvedValue(
      recorded({ state: 'deploying', deployment: { ...deployment, status: 'running' } }),
    );

    const reading = await readServingNow(PROJECT_ID, now);
    expect(reading.kind).toBe('unreadable');
    expect(reading.kind === 'unreadable' && reading.why).toMatch(/is not a finished deployment/);
  });

  it('reads a finished deployment that recorded no commit, and no probe, as unreadable', async () => {
    readState.mockResolvedValue(recorded({ source: { kind: 'unrecorded' } }));

    const reading = await readServingNow(PROJECT_ID, now);
    expect(reading.kind === 'unreadable' && reading.why).toMatch(/records no commit/);
  });

  it('says undeclared, and why, where the project has declared no document', async () => {
    readDocument.mockResolvedValue(null);

    const reading = await readServingNow(PROJECT_ID, now);
    expect(reading).toMatchObject({ kind: 'undeclared' });
    expect(reading.kind === 'undeclared' && reading.missing).toMatch(/no project document/);
    expect(readState).not.toHaveBeenCalled();
  });

  it('says undeclared where the document declares no production environment', async () => {
    readDocument.mockResolvedValue({ revision: 1, document: projectDoc({}) });

    expect(await readServingNow(PROJECT_ID, now)).toMatchObject({
      kind: 'undeclared',
      missing: 'the project document declares no production environment',
    });
  });

  it('reads an adapter that failed, and a route with nothing on record yet, as unreadable', async () => {
    readState.mockResolvedValue({
      environment: 'beta',
      state: 'unknown',
      evidence: 'none',
      reason: { cause: 'adapter-error', message: 'coolify answered 502' },
    });
    expect(await readServingNow(PROJECT_ID, now)).toMatchObject({
      kind: 'unreadable',
      why: 'coolify answered 502',
    });

    readState.mockResolvedValue({
      environment: 'beta',
      state: 'unknown',
      evidence: 'none',
      reason: { cause: 'no-record', message: 'coolify has recorded no deployment' },
    });
    expect(await readServingNow(PROJECT_ID, now)).toMatchObject({
      kind: 'unreadable',
      why: 'coolify has recorded no deployment',
    });
  });
});

describe('servedClause', () => {
  it('groups every place a commit runs under that commit, in the order first answered', () => {
    const served = [
      { commit: SERVED, where: 'App (preview)' },
      { commit: OTHER, where: 'Web (live)' },
      { commit: OTHER, where: 'Home (live)' },
    ];
    expect(servedClause(served)).toBe(
      `\`${SERVED}\` at App (preview); \`${OTHER}\` at Web (live) and Home (live)`,
    );
  });

  // ISS-1346 criterion 25: one commit answered full by one source and short by another.
  it('names one commit answered in two spellings once, under the longest', () => {
    const served = [
      { commit: SERVED.slice(0, 7), where: 'https://one.test/health' },
      { commit: SERVED, where: 'Web (live)' },
    ];
    expect(servedClause(served)).toBe(`\`${SERVED}\` at https://one.test/health and Web (live)`);
  });

  it('names each distinct commit once, however many places run it', () => {
    const reading = {
      kind: 'serving' as const,
      served: [
        { commit: OTHER, where: 'a' },
        { commit: SERVED, where: 'b' },
        { commit: OTHER, where: 'c' },
      ],
      unread: [],
      readAt: FROZEN.toISOString(),
    };
    expect(servedCommits(reading)).toEqual([OTHER, SERVED]);
    expect(servedCommits({ kind: 'undeclared', missing: 'm', route: 'r' })).toEqual([]);
  });
});
