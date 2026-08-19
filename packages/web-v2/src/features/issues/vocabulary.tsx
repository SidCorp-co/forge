"use client";

// Which status vocabulary this screen reads in.
//
// The label depends on the PROJECT, not on the issue, so threading it through
// every row component's props would put a project concern in five component
// APIs that have no other reason to know about one. A context set once per
// project route is the shape that matches where the fact lives.
//
// Absent provider means the kernel vocabulary — which is what every screen
// outside a project route shows, and what a staged project shows anyway.

import { readPipelineMode } from "@forge/contracts/issue-vocabulary";
import { createContext, useContext, useMemo } from "react";
import { useProject } from "@/features/projects/hooks";
import { statusLabelFor } from "./derive";
import type { IssueStatus } from "./types";

export type StatusLabeller = (status: IssueStatus) => string;

const VocabularyContext = createContext<string | undefined>(undefined);

export function IssueVocabularyProvider({
  projectId,
  children,
}: {
  projectId: string | undefined;
  children: React.ReactNode;
}) {
  const { data } = useProject(projectId);
  const mode = readPipelineMode(data?.agentConfig);
  return (
    <VocabularyContext.Provider value={mode}>
      {children}
    </VocabularyContext.Provider>
  );
}

/**
 * Label a status the way the surrounding project reads. Outside a provider it
 * is the kernel status, unchanged.
 */
// cm:edge contract -> packages/contracts/src/issue-vocabulary.ts — the kernel→label map; this hook only decides WHICH vocabulary, never what a label says
export function useStatusLabeller(): StatusLabeller {
  const mode = useContext(VocabularyContext);
  return useMemo(
    () => (status: IssueStatus) => statusLabelFor(status, mode),
    [mode],
  );
}
