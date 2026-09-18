"use client";

// Which LANE a status is shown under — the nine-bucket word, not the status.
//
// The label depends on nothing but the status, so this is a plain function
// wearing a hook's shape. It stayed a hook when the per-project vocabulary went
// away (ISS-897, one lane) because several row components call it and none of
// them has another reason to change.
//
// cm:guard the name says `lane` on purpose (ISS-1097). It was `useStatusLabeller`
// reaching `statusLabelFor`, which reads as "the label for this status", and four
// surfaces took it to report a status: the STATUS column, the detail header, the
// properties rail and the post-transition toast. A caller reporting a status wants
// `statusLabel` from ./derive; this one is for a surface that wants nine buckets.

import { useCallback } from "react";
import { laneLabel } from "./derive";
import type { IssueStatus } from "./types";

export type LaneLabeller = (status: IssueStatus) => string;

// cm:edge contract -> packages/contracts/src/issue-vocabulary.ts — the kernel-to-label map; this hook only reaches it, never decides what a label says
export function useLaneLabeller(): LaneLabeller {
  return useCallback((status: IssueStatus) => laneLabel(status), []);
}
