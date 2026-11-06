import { createContext, use } from "react";

// The release tour runs on a release's page, and the releases feature sits above tours in the
// layers, so the shell hands over which release of the open project a tour may open. It reads that
// release only once a tour list asks (`want`), never on every route (ISS-1070).
export interface TourRelease {
  /** The release a tour opens, null while unread or where the project shipped none. */
  version: string | null;
  /** Ask the shell to read it; the tour list calls this when it opens. */
  want: () => void;
}

const TourReleaseContext = createContext<TourRelease>({ version: null, want: () => {} });

export const TourReleaseProvider = TourReleaseContext.Provider;

export function useTourRelease(): TourRelease {
  return use(TourReleaseContext);
}
