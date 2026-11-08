// When each support session last took an act through Forge's support door, a read or a refused act
// included (ISS-1007): a completed turn that took none did nothing for the messages it was handed,
// which `dispatch.ts` reads as a failed turn. In memory, as the room's last hand-over is: core
// restarting forgets both, and such a turn is then not retried.

const lastAct = new Map<string, Date>();

export function noteSessionAct(sessionId: string, at: Date = new Date()): void {
  lastAct.set(sessionId, at);
}

export function lastSessionAct(sessionId: string): Date | undefined {
  return lastAct.get(sessionId);
}
