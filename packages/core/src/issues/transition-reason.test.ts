import { describe, expect, it } from 'vitest';
import {
  announcesAMove,
  buildTransitionReasonBody,
  parkReasonFault,
  reasonWaived,
  requiresAuthoredReason,
} from './transition-reason.js';

describe('on_hold is a reason-required status (ISS-1251)', () => {
  it('owes a reason from every status but itself', () => {
    expect(requiresAuthoredReason('in_progress', 'on_hold')).toBe(true);
    expect(requiresAuthoredReason('open', 'on_hold')).toBe(true);
    expect(requiresAuthoredReason('closed', 'on_hold')).toBe(true);
    expect(requiresAuthoredReason('on_hold', 'on_hold')).toBe(false);
  });

  it('does not let a trusted writer waive it, though it still waives the older three', () => {
    expect(reasonWaived('on_hold', true)).toBe(false);
    expect(reasonWaived('needs_info', true)).toBe(true);
    expect(reasonWaived('waiting', true)).toBe(true);
    expect(reasonWaived('reopen', true)).toBe(true);
    expect(reasonWaived('on_hold', undefined)).toBe(false);
  });

  it('refuses a missing, empty and blank reason by name, trusted writer or not', () => {
    for (const transitionReason of [undefined, '', '   \n']) {
      for (const skip of [undefined, true]) {
        const fault = parkReasonFault('in_progress', 'on_hold', { transitionReason, skip });
        expect(fault?.code).toBe('TRANSITION_REASON_REQUIRED');
        expect(fault?.detail).toContain('On hold');
        expect(fault?.detail).toContain('`reason`');
      }
    }
  });

  it('accepts a reason, and asks for no waiting kind', () => {
    expect(
      parkReasonFault('in_progress', 'on_hold', { transitionReason: 'paused for the window' }),
    ).toBeNull();
  });

  it('leaves a trusted writer’s reasonless move into the older three as it was', () => {
    expect(parkReasonFault('open', 'needs_info', { skip: true })).toBeNull();
  });

  it('writes a first line that names On hold and the status left, and that a reader recognises as a move', () => {
    const body = buildTransitionReasonBody('on_hold', 'testing', 'paused for the window');
    expect(body.split('\n')[0]).toBe('⏸ **On hold** — moved from `testing`');
    expect(body).toContain('paused for the window');
    expect(announcesAMove(body)).toBe(true);
    expect(
      buildTransitionReasonBody('waiting', 'testing', 'x', 'needs_decision').split('\n')[0],
    ).not.toBe(body.split('\n')[0]);
  });
});
