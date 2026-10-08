"use client";

import { blockToText, type VisualBlock } from "@forge/contracts/visual-blocks";

/**
 * What a drawing says, as the contract's own text fallback, for a reader who cannot see it. The
 * drawing is hidden from assistive technology so the same facts are not read twice.
 */
export function TextAlternative({ block }: { block: VisualBlock }) {
  return (
    <div className="sr-only whitespace-pre-line" data-testid="visual-block-alt">
      {blockToText(block)}
    </div>
  );
}
