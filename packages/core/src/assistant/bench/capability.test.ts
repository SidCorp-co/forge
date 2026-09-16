/**
 * ISS-1061 — the per-capability summary: the ladder's score rule over the tasks that carry each
 * capability, absent where none was walked, the judge as a column, and the one-line printout.
 */

import { describe, expect, it } from 'vitest';
import { capabilityLines, passKMean, summarizeCapabilities } from './capability.js';
import { sideOf } from './compare.js';
import type { Capability } from './task.js';

const trial = (pass: boolean, served?: 'yes' | 'no') => ({
  at: 'x',
  pass,
  error: null,
  seconds: 1,
  turns: [
    {
      index: 0,
      message: 'm',
      reply: 'r',
      pass,
      modes: [],
      evidence: [],
      seconds: 1,
      attempts: [],
      ...(served ? { judge: { intent: 'i', served, reason: 'r', quote: '' } } : {}),
    },
  ],
  cleanup: {
    rooms: [],
    preferences: { expected: null, observed: null, equal: null, at: null },
    auditRowsAdded: 0,
    memories: null,
  },
});

const sided = (id: string, capability: Capability, passes: boolean[], served?: 'yes' | 'no') => ({
  id,
  capability,
  side: sideOf(
    passes.map((p) => trial(p, served)),
    3,
  ),
});

describe('summarizeCapabilities', () => {
  it('groups the tasks by capability in the fixed order, scoring each with the ladder rule', () => {
    const out = summarizeCapabilities([
      sided('needle', 'long-context', [true, true, true], 'yes'),
      sided('counts', 'project-understanding', [true, true, false], 'no'),
      sided('states', 'project-understanding', [true, true, true], 'yes'),
      sided('a', 'method', [true, true, true]),
    ]);
    expect(out.map((s) => s.capability)).toEqual([
      'method',
      'project-understanding',
      'long-context',
    ]);
    expect(out[1]).toEqual({
      capability: 'project-understanding',
      tasks: ['counts', 'states'],
      score: 50,
      lowest: { id: 'counts', passK: 0 },
      fullTasks: 1,
      judge: { judged: 6, yes: 3, partial: 0, no: 3, unreadable: 0 },
    });
    expect(out[0]?.judge).toBeNull();
    expect(out.find((s) => s.capability === 'memory-storing')).toBeUndefined();
  });

  it('a capability whose every side is thin has a null score and no lowest task', () => {
    const [only] = summarizeCapabilities([sided('recall', 'memory-storing', [true])]);
    expect(only).toMatchObject({ score: null, lowest: null, fullTasks: 0, tasks: ['recall'] });
  });

  it('passKMean is the ladder score: mean of pass^k to one decimal, lowest ties by id', () => {
    expect(
      passKMean([
        sided('b', 'method', [true, true, false]),
        sided('a', 'method', [true, true, false]),
      ]),
    ).toEqual({ score: 0, lowest: { id: 'a', passK: 0 } });
    expect(passKMean([])).toEqual({ score: null, lowest: null });
  });
});

describe('capabilityLines', () => {
  it('prints score, full count, the judge column and the lowest task, one line each', () => {
    const lines = capabilityLines(
      summarizeCapabilities([
        sided('counts', 'project-understanding', [true, true, false], 'no'),
        sided('states', 'project-understanding', [true, true, true], 'yes'),
        sided('recall', 'memory-storing', [true]),
      ]),
    );
    expect(lines).toEqual([
      'project-understanding: score 50.0 · full 1/2 · judge yes 3/6 · lowest counts',
      'memory-storing: score — · full 0/1 · judge —',
    ]);
  });
});
