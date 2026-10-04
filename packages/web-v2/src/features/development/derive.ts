import { ISSUE_ATTENTION_LABELS } from "@forge/contracts/issue-standing";
import type { CoverageSegment } from "@/design";
import type { OverviewAttentionPart } from "./types";

export const partSegments = (parts: readonly OverviewAttentionPart[]): CoverageSegment[] =>
  parts.map((p) => ({
    key: p.group,
    label: ISSUE_ATTENTION_LABELS[p.group].label,
    count: p.count,
    tone: ISSUE_ATTENTION_LABELS[p.group].tone,
    hint: ISSUE_ATTENTION_LABELS[p.group].hint ?? undefined,
  }));

export const partsLine = (parts: readonly OverviewAttentionPart[]): string =>
  parts.map((p) => `${ISSUE_ATTENTION_LABELS[p.group].label} ${p.count}`).join(" · ");
