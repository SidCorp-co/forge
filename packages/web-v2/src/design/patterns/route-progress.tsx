"use client";

import NextTopLoader from "nextjs-toploader";

/** The 2px bar along the top while a route loads: nextjs-toploader, in the accent. */
export function RouteProgress() {
  return <NextTopLoader color="var(--accent)" height={2} showSpinner={false} shadow={false} zIndex={80} />;
}
