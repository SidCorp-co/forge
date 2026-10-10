"use client";

import { useSyncExternalStore } from "react";

const never = () => () => {};

/** A value only the browser knows (a permission, an origin, a stored opt-in), read without an
 *  effect: `server` on the server and the first paint, the browser's own once hydrated. */
export function useBrowserValue<T>(read: () => T, server: T): T {
  return useSyncExternalStore(never, read, () => server);
}
