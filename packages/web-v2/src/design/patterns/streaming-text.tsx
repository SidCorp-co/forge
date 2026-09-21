"use client";

import { cn } from "@/lib/utils/cn";
import { Markdown } from "./markdown";

export interface StreamingTextProps {
  text: string;
  /** While true, a blinking caret trails the text (agent is still emitting). */
  streaming?: boolean;
  className?: string;
}

export function StreamingText({ text, streaming, className }: StreamingTextProps) {
  return (
    <div
      className={cn("fg-body", streaming && "forge-caret", className)}
      {...(streaming ? { "data-streaming": "true" } : {})}
    >
      <Markdown className="forge-caret-anchor">{text}</Markdown>
    </div>
  );
}
