let listening = false;

/** The WebSocket door reports whether its server is attached, for the health read. */
export function markWsListening(value: boolean): void {
  listening = value;
}

export function isWsListening(): boolean {
  return listening;
}

/** What runs when a box's socket starts reading its own room: a box connecting, or reconnecting. */
type BoxListening = (deviceId: string) => void;
const boxListeners: BoxListening[] = [];

/** Registered once at boot by a module that acts on a box coming back (ISS-850). */
export function onBoxListening(fn: BoxListening): void {
  boxListeners.push(fn);
}

/** The WebSocket door reports a box's socket subscribed to its own room. */
export function boxBeganListening(deviceId: string): void {
  for (const fn of boxListeners) fn(deviceId);
}
