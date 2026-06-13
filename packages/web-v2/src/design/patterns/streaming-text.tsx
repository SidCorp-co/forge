"use client";

import { cn } from "@/lib/utils/cn";
import { Markdown } from "./markdown";

export interface StreamingTextProps {
  text: string;
  /** While true, a blinking caret trails the text (agent is still emitting). */
  streaming?: boolean;
  className?: string;
}

/**
 * Renders agent output as markdown (via the shared `Markdown` pattern) with a
 * blinking caret trailing it while tokens are still arriving. Agent replies are
 * markdown, so they must render formatted rather than as raw source (ISS-474).
 */
export function StreamingText({ text, streaming, className }: StreamingTextProps) {
  return (
    <div className={cn("fg-body", className)}>
      <Markdown>{text}</Markdown>
      {streaming && <span className="forge-caret" aria-hidden />}
    </div>
  );
}
