"use client";

// Renders an uploaded HTML attachment the way an artifact viewer does: inside a
// sandboxed iframe fed by `srcDoc`. The page may style and script itself, but
// its origin is opaque, so it cannot read the session it is embedded in.
//
// Presentational only — the caller hands over the markup. Fetching the bytes
// belongs to the feature layer (arch `web-design-holds-no-api-client`).

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

  // cm:guard the iframe's sandbox below must NEVER gain `allow-same-origin`. Paired with `allow-scripts` that hands the embedded page the app's own origin, and this markup is uploaded by anyone who can comment — session cookies, tokens and the whole DOM become readable. `allow-scripts` alone keeps the origin opaque, which is the only reason rendering uploaded HTML at all is safe.
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
