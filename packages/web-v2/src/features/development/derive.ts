import { ISSUE_ATTENTION_LABELS } from "@forge/contracts/issue-standing";
import type { CoverageSegment } from "@/design";
import type { Copy } from "@/lib/i18n/product-copy";
import type { OverviewAttentionPart } from "./types";

export const partSegments = (parts: readonly OverviewAttentionPart[], t: Copy): CoverageSegment[] =>
  parts.map((p) => ({
    key: p.group,
    label: t(`issues.attention.${p.group}`),
    count: p.count,
    tone: ISSUE_ATTENTION_LABELS[p.group].tone,
    hint: t(`issues.attention.${p.group}.hint`),
  }));

export const partsLine = (parts: readonly OverviewAttentionPart[], t: Copy): string =>
  parts.map((p) => `${t(`issues.attention.${p.group}`)} ${p.count}`).join(" · ");
