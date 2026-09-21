"use client";

import { useCallback } from "react";
import { laneLabel } from "./derive";
import type { IssueStatus } from "./types";

export type LaneLabeller = (status: IssueStatus) => string;

export function useLaneLabeller(): LaneLabeller {
  return useCallback((status: IssueStatus) => laneLabel(status), []);
}
