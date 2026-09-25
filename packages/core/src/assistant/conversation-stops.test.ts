/**
 * The register a stop acts on: what it holds, what it ends, and what it says
 * about a room running nothing.
 */

import { describe, expect, it } from 'vitest';
import { isTurnRunning, registerTurnStop, stopConversationTurns } from './conversation-stops.js';

let next = 0;
const room = () => `room-${next++}`;

describe('a room running nothing', () => {
  it('is not running a turn', () => {
    expect(isTurnRunning(room())).toBe(false);
  });

  it('stops nothing, and says nothing was stopped', () => {
    expect(stopConversationTurns(room())).toBe(0);
  });
});

describe('a turn this core is holding open', () => {
  it('reads as running once it is registered', () => {
    const id = room();
    const stop = registerTurnStop(id);
    expect(isTurnRunning(id)).toBe(true);
    stop.release();
  });

  it('stops when the room is stopped, and the turn sees an abort', () => {
    const id = room();
    const stop = registerTurnStop(id);
    expect(stop.signal.aborted).toBe(false);
    expect(stopConversationTurns(id)).toBe(1);
    expect(stop.signal.aborted).toBe(true);
    stop.release();
  });

  it('says why the turn ended', () => {
    const id = room();
    const stop = registerTurnStop(id);
    stopConversationTurns(id);
    expect(stop.signal.reason).toBe('stopped-by-a-person');
    stop.release();
  });

  it('stops being running once it is released', () => {
    const id = room();
    registerTurnStop(id).release();
    expect(isTurnRunning(id)).toBe(false);
  });

  it('leaves another room alone', () => {
    const mine = room();
    const theirs = room();
    const a = registerTurnStop(mine);
    const b = registerTurnStop(theirs);
    stopConversationTurns(mine);
    expect(a.signal.aborted).toBe(true);
    expect(b.signal.aborted).toBe(false);
    a.release();
    b.release();
  });
});

describe('two turns in one room', () => {
  it('stops both, and counts both', () => {
    const id = room();
    const a = registerTurnStop(id);
    const b = registerTurnStop(id);
    expect(stopConversationTurns(id)).toBe(2);
    expect([a.signal.aborted, b.signal.aborted]).toEqual([true, true]);
    a.release();
    b.release();
  });

  it('keeps reading as running until the last one is released', () => {
    const id = room();
    const a = registerTurnStop(id);
    const b = registerTurnStop(id);
    a.release();
    expect(isTurnRunning(id)).toBe(true);
    b.release();
    expect(isTurnRunning(id)).toBe(false);
  });
});
