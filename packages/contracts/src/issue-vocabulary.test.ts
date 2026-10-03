import { describe, expect, it } from 'vitest';
import {
  DONE_ISSUE_STATUSES,
  ISSUE_STATUS_HINTS,
  ISSUE_STATUS_LABELS,
  ISSUE_STATUS_TONES,
  NEEDS_INFO_KIND_LABELS,
  NEEDS_INFO_KINDS,
  PARKED_ISSUE_STATUSES,
  WORK_STEP_LABELS,
  WORK_STEPS,
} from './issue-vocabulary.js';
import { REGISTRY_ISSUE_STATUSES } from './pipeline-registry.js';

// ISS-54: the statuses are the labels. The autonomous label layer (running/unheld/needs_human/…)
// and its round-trip through LABEL_TO_KERNEL are gone with it; what is left is one word, one tone
// and one hint per status, and every surface reads the same three maps.
describe('the status vocabulary', () => {
  it('names exactly the ten lifecycle statuses, no retired one', () => {
    expect([...REGISTRY_ISSUE_STATUSES].sort()).toEqual(
      [
        'approved',
        'awaiting_release',
        'closed',
        'draft',
        'dropped',
        'in_progress',
        'needs_info',
        'on_hold',
        'open',
        'reopen',
      ].sort(),
    );
    for (const retired of [
      'confirmed',
      'clarified',
      'developed',
      'testing',
      'tested',
      'releasing',
      'waiting',
    ]) {
      expect(REGISTRY_ISSUE_STATUSES).not.toContain(retired);
    }
  });

  it('gives every status a label, a tone and a hint, and nothing else', () => {
    const statuses = [...REGISTRY_ISSUE_STATUSES].sort();
    expect(Object.keys(ISSUE_STATUS_LABELS).sort()).toEqual(statuses);
    expect(Object.keys(ISSUE_STATUS_TONES).sort()).toEqual(statuses);
    expect(Object.keys(ISSUE_STATUS_HINTS).sort()).toEqual(statuses);
  });

  it('starts every hint with the status it explains', () => {
    for (const status of REGISTRY_ISSUE_STATUSES) {
      expect(ISSUE_STATUS_HINTS[status].startsWith(`${status}:`)).toBe(true);
    }
  });

  it('gives no two statuses the same label', () => {
    const labels = Object.values(ISSUE_STATUS_LABELS);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('reads only in_progress as held by a run', () => {
    const run = REGISTRY_ISSUE_STATUSES.filter((s) => ISSUE_STATUS_TONES[s] === 'run');
    expect(run).toEqual(['in_progress']);
  });

  it('reads approved as ready for a master, not as a run in flight', () => {
    expect(ISSUE_STATUS_TONES.approved).toBe('ready');
  });

  it('reads reopen as a close somebody disputed, not as open', () => {
    expect(ISSUE_STATUS_LABELS.reopen).toBe('Reopened');
    expect(ISSUE_STATUS_TONES.reopen).toBe('err');
    expect(ISSUE_STATUS_TONES.reopen).not.toBe(ISSUE_STATUS_TONES.open);
    expect(PARKED_ISSUE_STATUSES).not.toContain('reopen');
  });

  it('reads a deliberate pause apart from a question for a person', () => {
    expect(ISSUE_STATUS_TONES.on_hold).toBe('neutral');
    expect(ISSUE_STATUS_TONES.needs_info).toBe('you');
  });

  it('reads awaiting_release as waiting on a person', () => {
    expect(ISSUE_STATUS_TONES.awaiting_release).toBe('you');
  });
});

describe('DONE_ISSUE_STATUSES and PARKED_ISSUE_STATUSES', () => {
  it('keeps done and dropped apart as statuses but both over', () => {
    expect([...DONE_ISSUE_STATUSES].sort()).toEqual(['closed', 'dropped']);
    expect(ISSUE_STATUS_LABELS.closed).not.toBe(ISSUE_STATUS_LABELS.dropped);
    for (const status of DONE_ISSUE_STATUSES) expect(ISSUE_STATUS_TONES[status]).toBe('done');
  });

  it('parks exactly needs_info and on_hold', () => {
    expect([...PARKED_ISSUE_STATUSES].sort()).toEqual(['needs_info', 'on_hold']);
  });

  it('never counts one status as both over and parked', () => {
    for (const status of DONE_ISSUE_STATUSES) expect(PARKED_ISSUE_STATUSES).not.toContain(status);
  });
});

describe('WORK_STEPS', () => {
  it('orders the run steps triage → release', () => {
    expect(WORK_STEPS).toEqual(['triage', 'clarify', 'plan', 'build', 'test', 'release']);
  });

  it('labels every step and nothing else', () => {
    expect(Object.keys(WORK_STEP_LABELS).sort()).toEqual([...WORK_STEPS].sort());
  });

  it('shares no word with a status, so a step cannot be read as one', () => {
    for (const step of WORK_STEPS) {
      expect(REGISTRY_ISSUE_STATUSES as readonly string[]).not.toContain(step);
    }
  });
});

describe('NEEDS_INFO_KINDS', () => {
  it('names the three things a needs_info park can be stopped on', () => {
    expect([...NEEDS_INFO_KINDS].sort()).toEqual(
      ['needs_answer', 'needs_decision', 'needs_resource'].sort(),
    );
  });

  it('labels every kind and nothing else', () => {
    expect(Object.keys(NEEDS_INFO_KIND_LABELS).sort()).toEqual([...NEEDS_INFO_KINDS].sort());
  });
});
