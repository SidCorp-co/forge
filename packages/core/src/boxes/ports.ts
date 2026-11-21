import { portSlot } from '../lib/port-slot.js';

// What the boxes module needs from the WebSocket door, handed in by the process entry at boot
// (ADR 0008). Read only inside a call.

interface BoxesPorts {
  /**
   * Hand a frame to the box's open sockets now, answering how many took it; nothing is written
   * down, so an act carrying a session value (ISS-1386) rests in no outbox row or queue job.
   */
  sendToBoxNow(deviceId: string, envelope: { event: string; data: unknown }): number;
}

const slot = portSlot<BoxesPorts>('boxes', 'provideBoxesPorts');
export const provideBoxesPorts = slot.provide;
export const boxesPorts = slot.get;
