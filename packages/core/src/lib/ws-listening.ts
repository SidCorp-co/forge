let listening = false;

/** The WebSocket door reports whether its server is attached, for the health read. */
export function markWsListening(value: boolean): void {
  listening = value;
}

export function isWsListening(): boolean {
  return listening;
}
