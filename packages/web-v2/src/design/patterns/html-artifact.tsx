"use client";


import { useState } from "react";
import { cn } from "@/lib/utils/cn";
import { Icon } from "../icons/icon";

export interface HtmlArtifactProps {
  html: string;
  title?: string;
  className?: string;
  /** Collapsed height in px. Expanded is 3x, capped by the viewport. */
  height?: number;
}

export function HtmlArtifact({ html, title, className, height = 420 }: HtmlArtifactProps) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className={cn("overflow-hidden rounded-lg border border-line bg-surface", className)}>
      <header className="flex items-center gap-2 border-b border-line bg-sunken px-3 py-1.5">
        <Icon name="folder" size={14} className="flex-none text-subtle" />
        <span className="fg-caption min-w-0 flex-1 truncate text-muted" title={title}>
          {title ?? "HTML attachment"}
        </span>
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="fg-caption flex-none rounded px-2 py-0.5 text-muted hover:bg-hover hover:text-fg focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
        >
          {expanded ? "Collapse" : "Expand"}
        </button>
      </header>
      <iframe
        sandbox="allow-scripts"
        srcDoc={html}
        title={title ?? "HTML attachment"}
        loading="lazy"
        className="block w-full border-0 bg-white"
        style={{ height: expanded ? Math.min(height * 3, 1400) : height }}
      />
    </div>
  );
}
