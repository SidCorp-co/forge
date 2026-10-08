"use client";

import type { BlockSource } from "@forge/contracts/visual-blocks";
import { createContext, type ReactNode, useContext } from "react";

/** What a run says about itself: the query that produced a frame and the moment it was read. */
export interface SourceFacts {
  queryId: string;
  asOf: string;
}

export interface VisualBlockContextValue {
  /** The project's slug, for the links a ref cell opens; without it a ref is drawn as plain text. */
  projectSlug: string | undefined;
  /** The query and read time of a block's source, where this screen can read them. */
  sourceFacts?: (source: BlockSource) => SourceFacts | undefined;
}

const VisualBlockContext = createContext<VisualBlockContextValue>({ projectSlug: undefined });

export function VisualBlockProvider({ value, children }: { value: VisualBlockContextValue; children: ReactNode }) {
  return <VisualBlockContext.Provider value={value}>{children}</VisualBlockContext.Provider>;
}

export const useVisualBlockContext = (): VisualBlockContextValue => useContext(VisualBlockContext);
