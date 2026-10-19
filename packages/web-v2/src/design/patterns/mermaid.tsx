"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils/cn";
import { DIAGRAM_ROOT_SELECTOR, edgeMask, hiddenSides, rootScrollLeft } from "./mermaid-scroll";
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
  const [sides, setSides] = useState({ start: false, end: false });

  // Mermaid fits the svg to the column; past the floor it would shrink the labels out of reading.
  // A diagram then wider than its box opens with its root in view and says which edges hide more.
  useLayoutEffect(() => {
    const el = box.current;
    const drawn = svg ? el?.querySelector("svg") : null;
    if (!el || !drawn) return;
    const floor = diagramMinWidth(drawn.getAttribute("viewBox"));
    if (floor !== null) drawn.style.minWidth = `${floor}px`;
    const root = drawn.querySelector(DIAGRAM_ROOT_SELECTOR)?.getBoundingClientRect();
    const start = el.getBoundingClientRect().left - el.scrollLeft;
    el.scrollLeft = rootScrollLeft(el, root ? { left: root.left - start, width: root.width } : null);
    const read = () => setSides(hiddenSides(el));
    read();
    el.addEventListener("scroll", read, { passive: true });
    const resized = new ResizeObserver(read);
    resized.observe(el);
    return () => {
      el.removeEventListener("scroll", read);
      resized.disconnect();
    };
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

  const mask = edgeMask(sides);
  const scrolls = sides.start || sides.end;
  return (
    <div className={cn("max-w-full", className)}>
      <section
        ref={box}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: a scroll container is focusable so arrow keys scroll it
        tabIndex={0}
        aria-label="Diagram"
        aria-describedby={scrolls ? `${id}-scrolls` : undefined}
        className="max-w-full overflow-x-auto rounded-md focus-visible:shadow-[var(--shadow-focus)] focus-visible:outline-none"
        style={mask ? { maskImage: mask, WebkitMaskImage: mask } : undefined}
        // biome-ignore lint/security/noDangerouslySetInnerHtml: mermaid produces sanitized SVG under securityLevel:strict
        dangerouslySetInnerHTML={{ __html: svg }}
      />
      {scrolls && (
        <p id={`${id}-scrolls`} className="fg-caption mt-1 text-subtle" data-testid="diagram-scrolls">
          Wider than this column — scroll sideways to see all of it.
        </p>
      )}
    </div>
  );
}
