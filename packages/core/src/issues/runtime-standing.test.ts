import { describe, expect, it } from 'vitest';
import type { Carriage, ChangedPaths } from '../release-batch/carriage.js';
import type { ServingReading } from '../release-batch/serving-reading.js';
import {
  carriageKey,
  type RuntimeReading,
  UNWEIGHED,
  type Weighing,
} from '../release-batch/weighing.js';
import { owedRuntimes, weighVerdict } from './runtime-standing.js';
import { verdictStanding } from './verdict-standing.js';

const J = '655cc09cebfc9eb07840dfed6bccd04aaf7f1728';
const CORE = '7252b45c5bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const BUILD = '07f2009aaccccccccccccccccccccccccccccccc';
const OTHER_BUILD = '82ce8f4ddddddddddddddddddddddddddddddddd';
const READ_AT = '2026-10-01T10:00:00.000Z';
const RUNNER_FILE = 'packages/runner/src/a.rs';

const source = { kind: 'source' as const, value: J };
const ids = { source: J };

const served = (...commits: string[]): ServingReading => ({
  kind: 'serving',
  served: commits.map((commit, i) => ({ commit, where: `host ${i}` })),
  unread: [],
  readAt: READ_AT,
});

const runner = (serving: ServingReading): RuntimeReading => ({
  name: 'runner',
  paths: ['packages/runner'],
  serving,
});

function weighing(args: {
  runtimes?: RuntimeReading[];
  changed?: ChangedPaths;
  carriage?: Array<[string, string, Carriage]>;
}): Weighing {
  return {
    read: true,
    runtimes: args.runtimes ?? [],
    changed: new Map(args.changed ? [['iss', args.changed]] : []),
    carriage: new Map((args.carriage ?? []).map(([j, s, c]) => [carriageKey(j, s), c])),
  };
}

const descends: Carriage = { kind: 'descends' };
const differs = (...paths: string[]): Carriage => ({ kind: 'differs', paths });

describe('owedRuntimes', () => {
  it('owes only the deployment where no runtime is declared', () => {
    expect(owedRuntimes('iss', UNWEIGHED)).toEqual({
      deployment: true,
      declared: [],
      unread: null,
    });
  });

  it('owes the runner alone for a runner-only landing', () => {
    const w = weighing({
      runtimes: [runner(served(BUILD))],
      changed: { kind: 'read', paths: [RUNNER_FILE] },
    });
    const owed = owedRuntimes('iss', w);
    expect(owed.deployment).toBe(false);
    expect(owed.declared.map((r) => r.name)).toEqual(['runner']);
  });

  it('owes both for a landing touching both, and the deployment alone for a core-only one', () => {
    const both = weighing({
      runtimes: [runner(served(BUILD))],
      changed: { kind: 'read', paths: ['packages/core/a.ts', RUNNER_FILE] },
    });
    expect(owedRuntimes('iss', both)).toMatchObject({ deployment: true, unread: null });
    expect(owedRuntimes('iss', both).declared.map((r) => r.name)).toEqual(['runner']);
    const core = weighing({
      runtimes: [runner(served(BUILD))],
      changed: { kind: 'read', paths: ['packages/runnerx/a.ts'] },
    });
    expect(owedRuntimes('iss', core)).toEqual({ deployment: true, declared: [], unread: null });
  });

  it('owes the deployment for a landing that changed nothing', () => {
    const w = weighing({ runtimes: [runner(served(BUILD))], changed: { kind: 'read', paths: [] } });
    expect(owedRuntimes('iss', w)).toEqual({ deployment: true, declared: [], unread: null });
  });

  it('owes every runtime, saying why, where the paths were not read', () => {
    const w = weighing({
      runtimes: [runner(served(BUILD))],
      changed: { kind: 'unread', why: 'HTTP 502' },
    });
    const owed = owedRuntimes('iss', w);
    expect(owed.deployment).toBe(true);
    expect(owed.declared).toHaveLength(1);
    expect(owed.unread).toBe('HTTP 502');
  });
});

describe('weighVerdict — the three shapes ISS-1368 names', () => {
  const deploymentOnly = { deployment: true, declared: [], unread: null };

  it('stands where the deployment serves a descendant of the judged commit', () => {
    const w = weighing({ carriage: [[J, CORE, descends]] });
    expect(verdictStanding(source, served(CORE), ids)).toBe('superseded');
    expect(weighVerdict(source, served(CORE), ids, deploymentOnly, w).standing).toBe('stands');
  });

  it('stands for the deployment where it differs from the judged commit only in runner files', () => {
    const w = weighing({
      runtimes: [runner(served(BUILD))],
      carriage: [[J, CORE, differs(RUNNER_FILE)]],
    });
    expect(weighVerdict(source, served(CORE), ids, deploymentOnly, w).standing).toBe('stands');
  });

  it('is superseded for the deployment where a file it runs differs, naming the file', () => {
    const w = weighing({
      runtimes: [runner(served(BUILD))],
      carriage: [[J, CORE, differs('packages/core/a.ts', RUNNER_FILE)]],
    });
    const weighed = weighVerdict(source, served(CORE), ids, deploymentOnly, w);
    expect(weighed.standing).toBe('superseded');
    expect(weighed.runtime).toBeNull();
    expect(weighed.beside.join(' ')).toContain(
      'differs from it in 1 file it runs: `packages/core/a.ts`',
    );
  });

  it('stands in the runner where one of two devices runs a build tree-equal on runner paths', () => {
    const runners = runner(served(OTHER_BUILD, BUILD));
    const w = weighing({
      runtimes: [runners],
      carriage: [
        [J, OTHER_BUILD, differs(RUNNER_FILE)],
        [J, BUILD, differs('CHANGELOG.md')],
      ],
    });
    const owed = { deployment: false, declared: [runners], unread: null };
    expect(weighVerdict(source, served(CORE), ids, owed, w).standing).toBe('stands');
  });

  it('is superseded in the runner, naming it, where its build truly lacks the change', () => {
    const runners = runner(served(OTHER_BUILD));
    const w = weighing({ runtimes: [runners], carriage: [[J, OTHER_BUILD, differs(RUNNER_FILE)]] });
    const owed = { deployment: false, declared: [runners], unread: null };
    const weighed = weighVerdict(source, served(CORE), ids, owed, w);
    expect(weighed).toMatchObject({ standing: 'superseded', runtime: 'runner' });
    expect(weighed.beside.join(' ')).toContain('what it serves does not descend from it');
  });

  it('names each served build where several run and none carries it', () => {
    const runners = runner(served(OTHER_BUILD, BUILD));
    const w = weighing({
      runtimes: [runners],
      carriage: [
        [J, OTHER_BUILD, differs(RUNNER_FILE)],
        [J, BUILD, { kind: 'unread', why: 'HTTP 502' }],
      ],
    });
    const owed = { deployment: false, declared: [runners], unread: null };
    const said = weighVerdict(source, served(CORE), ids, owed, w).beside.join('; ');
    expect(said).toContain(`\`${OTHER_BUILD}\` does not descend from it`);
    expect(said).toContain(`whether \`${BUILD}\` carries it could not be read: HTTP 502`);
  });

  it('owes both: the runner earning it does not cover a deployment that lacks it', () => {
    const runners = runner(served(BUILD));
    const w = weighing({
      runtimes: [runners],
      carriage: [
        [J, BUILD, descends],
        [J, CORE, differs('packages/core/a.ts')],
      ],
    });
    const owed = { deployment: true, declared: [runners], unread: null };
    expect(weighVerdict(source, served(CORE), ids, owed, w)).toMatchObject({
      standing: 'superseded',
      runtime: null,
    });
  });

  it('holds a criterion owed to a declared runtime nothing reports, even a runtime verdict', () => {
    const silent: ServingReading = {
      kind: 'unreadable',
      why: 'runner device box reports no build commit',
      hosts: ['box'],
      readAt: READ_AT,
    };
    const runners = runner(silent);
    const owed = { deployment: false, declared: [runners], unread: null };
    const runtime = { kind: 'runtime' as const, value: J };
    expect(
      weighVerdict(runtime, served(J), ids, owed, weighing({ runtimes: [runners] })),
    ).toMatchObject({
      standing: 'superseded',
      runtime: 'runner',
    });
  });
});

describe('weighVerdict — what it leaves as it was', () => {
  const deploymentOnly = { deployment: true, declared: [], unread: null };

  it('decides as equality did, saying nothing more, when nothing was weighed', () => {
    for (const reading of [served(CORE), served(J)]) {
      const weighed = weighVerdict(source, reading, ids, deploymentOnly, UNWEIGHED);
      expect(weighed.standing).toBe(verdictStanding(source, reading, ids));
      expect(weighed.beside).toEqual([]);
    }
  });

  it('falls back to equality, naming the served commit and why, where carriage was unread', () => {
    const w = weighing({ carriage: [[J, CORE, { kind: 'unread', why: 'HTTP 502' }]] });
    const weighed = weighVerdict(source, served(CORE), ids, deploymentOnly, w);
    expect(weighed.standing).toBe('superseded');
    expect(weighed.beside).toEqual([
      'whether what it serves carries it could not be read: HTTP 502',
    ]);
  });

  it('keeps an unreadable deployment reading earning a runtime verdict uncorroborated, as ISS-1286 does', () => {
    const unreadable: ServingReading = {
      kind: 'unreadable',
      why: 'ECONNREFUSED',
      hosts: ['h'],
      readAt: READ_AT,
    };
    const runtime = { kind: 'runtime' as const, value: J };
    expect(weighVerdict(runtime, unreadable, ids, deploymentOnly, weighing({})).standing).toBe(
      'uncorroborated',
    );
  });
});
