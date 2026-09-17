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
// cm:guard the caret is a CLASS on this block and never an element after it, and the reason is
// measured: `Markdown` renders a `<p>`, and an inline span following a block starts a new line box.
// In Chrome at 1200px on 2026-09-17 a streaming block whose prose was one 20px line rendered 44px
// tall, with the caret element's top at 50 against the paragraph's bottom at 44 — a whole line
// below the words it belonged to, and one line taller than the same block once settled. `globals.css`
// draws it as an `::after` on the last child inside the markdown wrapper instead, so it follows the
// final word and wraps with it (ISS-1083, the owner's call on 2026-09-17).
//
// cm:why `data-streaming` as well as the class: the class is what the stylesheet hangs off and the
// attribute is what a reader of the DOM — a test, a walk — asks. Tailwind's own `data-` variants
// mean the next rule that needs it does not need a second class either.
//
// cm:edge contract -> packages/web-v2/src/app/globals.css — the bar is drawn on the last child of
// `.forge-caret-anchor`, which is `Markdown`'s own wrapper wearing a name. Keyed off "the child
// div" instead, the caret would vanish in silence the day that component wrapped its output
// differently, and no test reading the stylesheet as text could see it. The class is the whole of
// the contract and it is passed, not assumed (implementation consult F2).
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
