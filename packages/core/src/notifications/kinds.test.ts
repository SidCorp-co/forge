import {
  INHIBIT_RULES as CONTRACT_INHIBIT_RULES,
  NOTIFICATION_CONTRACT,
  NOTIFICATION_TYPES,
} from '@forge/contracts/notifications';
import { describe, expect, it } from 'vitest';
import { notificationTypes } from '../db/schema.js';
import { INHIBIT_RULES, INITIAL_STATE, NOTIFICATION_KIND_TABLE, STATES_BY_KIND } from './kinds.js';

describe('the taxonomy is one taxonomy in three places (ISS-1063)', () => {
  it('the contract and the column declare the same types', () => {
    expect([...notificationTypes].sort()).toEqual([...NOTIFICATION_TYPES].sort());
  });

  it("core's mirror declares the same types as the column", () => {
    expect(Object.keys(NOTIFICATION_KIND_TABLE).sort()).toEqual([...notificationTypes].sort());
  });

  it('every type reads the same kind in the contract and in the mirror', () => {
    const disagreements = notificationTypes
      .map((t) => ({
        type: t,
        contract: NOTIFICATION_CONTRACT[t].kind,
        mirror: NOTIFICATION_KIND_TABLE[t].kind,
      }))
      .filter((r) => r.contract !== r.mirror);
    expect(disagreements).toEqual([]);
  });

  it('every type reads the same tier in the contract and in the mirror', () => {
    const disagreements = notificationTypes
      .map((t) => ({
        type: t,
        contract: NOTIFICATION_CONTRACT[t].tier,
        mirror: NOTIFICATION_KIND_TABLE[t].tier,
      }))
      .filter((r) => r.contract !== r.mirror);
    expect(disagreements).toEqual([]);
  });

  it('every type reads the same pending duration in the contract and in the mirror', () => {
    const disagreements = notificationTypes
      .map((t) => ({
        type: t,
        contract: NOTIFICATION_CONTRACT[t].pendingEvaluations ?? 0,
        mirror: NOTIFICATION_KIND_TABLE[t].pendingEvaluations ?? 0,
      }))
      .filter((r) => r.contract !== r.mirror);
    expect(disagreements).toEqual([]);
  });

  it('the inhibition rules are the same on both sides', () => {
    expect(INHIBIT_RULES).toEqual(CONTRACT_INHIBIT_RULES);
  });
});

describe('a kind means something (ISS-1063)', () => {
  it('no signal type declares a pending duration, because a signal is never pending', () => {
    const offenders = notificationTypes.filter(
      (t) =>
        NOTIFICATION_KIND_TABLE[t].kind === 'signal' &&
        NOTIFICATION_KIND_TABLE[t].pendingEvaluations,
    );
    expect(offenders).toEqual([]);
  });

  it('no task type declares a pending duration, because a task is not re-evaluated', () => {
    const offenders = notificationTypes.filter(
      (t) =>
        NOTIFICATION_KIND_TABLE[t].kind === 'task' && NOTIFICATION_KIND_TABLE[t].pendingEvaluations,
    );
    expect(offenders).toEqual([]);
  });

  it("each kind's initial state belongs to that kind's own set", () => {
    for (const [kind, state] of Object.entries(INITIAL_STATE)) {
      expect(STATES_BY_KIND[kind as keyof typeof STATES_BY_KIND]).toContain(state);
    }
  });

  it('no state name is shared between two kinds, so a state names its kind', () => {
    const all = Object.values(STATES_BY_KIND).flat();
    expect(all.length).toBe(new Set(all).size);
  });

  it('every inhibition rule names a condition on both sides — a signal cannot fire and a task is not suppressed by one', () => {
    const offenders = INHIBIT_RULES.filter(
      (r) =>
        NOTIFICATION_KIND_TABLE[r.source].kind !== 'condition' ||
        NOTIFICATION_KIND_TABLE[r.target].kind !== 'condition',
    );
    expect(offenders).toEqual([]);
  });
});
