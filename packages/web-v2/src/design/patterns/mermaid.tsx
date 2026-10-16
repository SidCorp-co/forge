"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils/cn";
import { diagramMinWidth } from "./mermaid-width";

interface MermaidDiagramProps {
  code: string;
  className?: string;
}

let mermaidReady = false;

async function initMermaid() {
  if (mermaidReady) return;
  const m = await import("mermaid");
  m.default.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    theme: "neutral",
    // Mermaid 12 defaults to the ELK layout and the neo look; these keep diagrams as they were drawn.
    layout: "dagre",
    look: "classic",
  });
  mermaidReady = true;
}

/** Client-only Mermaid diagram renderer. Never enters the SSR bundle (dynamic import). */
export function MermaidDiagram({ code, className }: MermaidDiagramProps) {
  const rawId = useId();
  const id = `mermaid-${rawId.replace(/:/g, "")}`;
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLElement>(null);

  // Mermaid fits the svg to the column; past the floor it would shrink the labels out of reading.
  useLayoutEffect(() => {
    const drawn = svg ? box.current?.querySelector("svg") : null;
    const floor = drawn ? diagramMinWidth(drawn.getAttribute("viewBox")) : null;
    if (drawn && floor !== null) drawn.style.minWidth = `${floor}px`;
  }, [svg]);

  useEffect(() => {
    let cancelled = false;
    setSvg(null);
    setError(null);

    (async () => {
      try {
        await initMermaid();
        const m = await import("mermaid");
        await m.default.parse(code);
        const { svg: rendered } = await m.default.render(id, code);
        if (!cancelled) setSvg(rendered);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [code, id]);

  if (error) {
    return (
      <div className={cn("rounded-md border border-line bg-sunken px-3 py-2", className)}>
        <p className="fg-caption font-mono text-red-600">Mermaid parse error: {error}</p>
        <pre className="mt-1 overflow-x-auto font-mono text-12 text-muted">{code}</pre>
      </div>
    );
  }

  if (!svg) {
    return (
      <div className={cn("h-24 animate-pulse rounded-md bg-sunken", className)} />
    );
  }

  return (
    <section
      ref={box}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: a scroll container is focusable so arrow keys scroll it
      tabIndex={0}
      aria-label="Diagram"
      className={cn(
        "max-w-full overflow-x-auto rounded-md focus-visible:shadow-[var(--shadow-focus)] focus-visible:outline-none",
        className,
      )}
      // biome-ignore lint/security/noDangerouslySetInnerHtml: mermaid produces sanitized SVG under securityLevel:strict
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
