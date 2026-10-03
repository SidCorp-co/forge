"use client";

import {
  FEEDBACK_PHASE_GLYPHS,
  FEEDBACK_PHASE_HINTS,
  FEEDBACK_PHASE_TONES,
  FEEDBACK_SEVERITY_TONES,
} from "@forge/contracts/feedback";
import { Badge, StatusChip } from "@/design";
import { toneChip } from "@/features/issues/derive";
import type { FeedbackKind, FeedbackPhase, FeedbackSeverity } from "../types";

/** `change_request` reads "Change request": chrome is sentence case, the raw value sits in the tooltip. */
export const sentence = (v: string) => {
  const t = v.replace(/_/g, " ");
  return t.charAt(0).toUpperCase() + t.slice(1);
};

export function PhaseBadge({ phase }: { phase: FeedbackPhase }) {
  return (
    <StatusChip
      size="sm"
      status={toneChip(FEEDBACK_PHASE_TONES[phase])}
      label={sentence(phase)}
      glyph={FEEDBACK_PHASE_GLYPHS[phase]}
      title={FEEDBACK_PHASE_HINTS[phase]}
    />
  );
}

export function SeverityBadge({ severity }: { severity: FeedbackSeverity }) {
  return (
    <StatusChip
      size="sm"
      status={toneChip(FEEDBACK_SEVERITY_TONES[severity])}
      label={sentence(severity)}
      title={`severity: ${severity}`}
    />
  );
}

export function KindBadge({ kind }: { kind: FeedbackKind }) {
  return (
    <span title={`kind: ${kind}`}>
      <Badge>{sentence(kind)}</Badge>
    </span>
  );
}
