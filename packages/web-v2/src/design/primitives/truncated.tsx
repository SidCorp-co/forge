"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils/cn";
import { TooltipPanel } from "./tooltip";

export interface TruncatedProps {
  text: string;
  className?: string;
}

/**
 * One line, an ellipsis where it is cut, the whole text in the title: never broken mid-word. Text
 * that is actually cut can be focused (a tap focuses it too), says all of itself to a screen reader
 * and shows all of itself beside the line while it holds focus; text that fits stays out of the tab order.
 */
export function Truncated({ text, className }: TruncatedProps) {
  const line = useRef<HTMLSpanElement>(null);
  const [cut, setCut] = useState(false);
  const [focused, setFocused] = useState(false);

  const measure = () => {
    const el = line.current;
    if (el) setCut(el.scrollWidth > el.clientWidth + 1);
  };
  useLayoutEffect(measure);
  useLayoutEffect(() => {
    const el = line.current;
    if (!el) return;
    const watch = new ResizeObserver(() => setCut(el.scrollWidth > el.clientWidth + 1));
    watch.observe(el);
    return () => watch.disconnect();
  }, []);

  return (
    <>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: a span that fits is never focused, so these fire only once it is cut and focusable, and a blur must clear the hold whatever its width. */}
      <span
        ref={line}
        title={text}
        className={cn("block min-w-0 truncate", className)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        {...(cut ? { tabIndex: 0, role: "group", "aria-label": text } : {})}
      >
        {text}
      </span>
      <TooltipPanel open={cut && focused} anchor={line} label={text} multiline />
    </>
  );
}
