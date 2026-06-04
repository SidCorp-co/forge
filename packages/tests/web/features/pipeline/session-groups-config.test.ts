import { describe, expect, it } from 'vitest';
import {
  __buildPipelinePatch as buildPipelinePatch,
  __fromServer as fromServer,
  buildSessionGroupsMap,
  type PipelineConfigFormState,
} from '@/features/pipeline/config/hooks/use-pipeline-config';
import type { PipelineConfig, StatesConfig } from '@/features/pipeline/config/types';

// Server fixture: two groups, with one stage carrying an extra per-stage
// field (`model`) the form does not model — used to prove a full-states
// rebuild preserves it.
const serverCfg: PipelineConfig = {
  enabled: true,
  states: {
    open: { enabled: true, mode: 'auto', sessionGroup: 'build' },
    confirmed: { enabled: true, mode: 'auto', sessionGroup: 'build', model: 'opus' },
    developed: { enabled: true, mode: 'auto', sessionGroup: 'verify' },
  },
  sessionGroups: { build: ['open', 'confirmed'], verify: ['developed'] },
};

const rawStates = serverCfg.states as StatesConfig;

function initialState(): PipelineConfigFormState {
  return fromServer({ pipelineConfig: serverCfg });
}

function clone(s: PipelineConfigFormState): PipelineConfigFormState {
  return JSON.parse(JSON.stringify(s)) as PipelineConfigFormState;
}

describe('fromServer — session groups hydration', () => {
  it('hydrates groupNames + per-stage assignment from the sessionGroups map', () => {
    const s = initialState();
    expect(s.sessionGroups.groupNames).toEqual(['build', 'verify']);
    expect(s.sessionGroups.assignment.open).toBe('build');
    expect(s.sessionGroups.assignment.confirmed).toBe('build');
    expect(s.sessionGroups.assignment.developed).toBe('verify');
    // Unlisted stages are Ungrouped.
    expect(s.sessionGroups.assignment.clarified).toBeNull();
    expect(s.sessionGroups.assignment.needs_info).toBeNull();
  });
});

describe('buildSessionGroupsMap', () => {
  it('emits stages in STAGE_NAMES order and drops empty groups', () => {
    const s = initialState();
    s.sessionGroups.groupNames = ['build', 'verify', 'empty'];
    s.sessionGroups.assignment.confirmed = 'verify';
    const map = buildSessionGroupsMap(s.sessionGroups);
    expect(map).toEqual({ build: ['open'], verify: ['confirmed', 'developed'] });
    expect('empty' in map).toBe(false);
  });
});

describe('buildPipelinePatch — session groups', () => {
  it('emits nothing when the partition is unchanged', () => {
    const initial = initialState();
    const patch = buildPipelinePatch(initial, initial, rawStates);
    expect(patch.sessionGroups).toBeUndefined();
    expect(patch.states).toBeUndefined();
  });

  it('writes the FULL sessionGroups map and a FULL states map on change', () => {
    const initial = initialState();
    const next = clone(initial);
    next.sessionGroups.assignment.confirmed = 'verify'; // move build → verify

    const patch = buildPipelinePatch(next, initial, rawStates);

    // Full map, wholesale (build keeps its remaining member; sibling retained).
    expect(patch.sessionGroups).toEqual({ build: ['open'], verify: ['confirmed', 'developed'] });

    // Full states map: every stage present, per-state sessionGroup written.
    expect(Object.keys(patch.states ?? {}).length).toBe(13);
    expect(patch.states?.open?.sessionGroup).toBe('build');
    expect(patch.states?.confirmed?.sessionGroup).toBe('verify');
    expect(patch.states?.developed?.sessionGroup).toBe('verify');

    // Untouched per-stage field preserved from the authoritative server config.
    expect((patch.states?.confirmed as { model?: string }).model).toBe('opus');

    // Ungrouped stages carry no sessionGroup pointer.
    expect(patch.states?.clarified?.sessionGroup).toBeUndefined();
    expect(patch.states?.needs_info?.sessionGroup).toBeUndefined();
  });

  it('drops a group once its last member leaves, without touching siblings', () => {
    const initial = initialState();
    const next = clone(initial);
    next.sessionGroups.assignment.open = null;
    next.sessionGroups.assignment.confirmed = null; // build now empty

    const patch = buildPipelinePatch(next, initial, rawStates);
    expect(patch.sessionGroups).toEqual({ verify: ['developed'] });
    expect(patch.states?.open?.sessionGroup).toBeUndefined();
    expect(patch.states?.confirmed?.sessionGroup).toBeUndefined();
    expect(patch.states?.developed?.sessionGroup).toBe('verify');
  });
});
