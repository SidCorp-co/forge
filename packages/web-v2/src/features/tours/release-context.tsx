"use client";

import { createContext, useContext } from "react";

// The release tour runs on a release's page, and the releases feature sits above tours in the
// layers, so the shell hands over which release of the open project a tour may open.
const TourReleaseContext = createContext<string | null>(null);

export const TourReleaseProvider = TourReleaseContext.Provider;

export function useTourRelease(): string | null {
  return useContext(TourReleaseContext);
}
