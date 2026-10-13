const NEXT_URL = "next-url";
const FETCH_DEST = "sec-fetch-dest";

export const FLIGHT_SIGNAL_HEADERS = `${NEXT_URL}, ${FETCH_DEST}`;

export function isFlightRequest(headers: Headers): boolean {
  return headers.has(NEXT_URL) || headers.get(FETCH_DEST) === "empty";
}
