"use client";

// Which label a status is shown under.
//
// The label depends on nothing but the status, so this is a plain function
// wearing a hook's shape. It stayed a hook when the per-project vocabulary went
// away (ISS-897, one lane) because five row components call it and none of them
// has another reason to change.

import { useCallback } from "react";
import { statusLabelFor } from "./derive";
import type { IssueStatus } from "./types";

export type StatusLabeller = (status: IssueStatus) => string;

export function useStatusLabeller(): StatusLabeller {
  return useCallback((status: IssueStatus) => statusLabelFor(status), []);
}
