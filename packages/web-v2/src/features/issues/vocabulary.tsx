"use client";


import { useCallback } from "react";
import { statusLabelFor } from "./derive";
import type { IssueStatus } from "./types";

export type StatusLabeller = (status: IssueStatus) => string;

export function useStatusLabeller(): StatusLabeller {
  return useCallback((status: IssueStatus) => statusLabelFor(status), []);
}
