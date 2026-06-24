"use client";

import { useEffect, useId, useRef, useState } from "react";
import { cn } from "@/lib/utils/cn";

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
  });
  mermaidReady = true;
}

/** Client-only Mermaid diagram renderer. Never enters the SSR bundle (dynamic import). */
export function MermaidDiagram({ code, className }: MermaidDiagramProps) {
  const rawId = useId();
  // useId can produce colons which mermaid doesn't accept as element id
  const id = `mermaid-${rawId.replace(/:/g, "")}`;
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const prevCode = useRef<string | null>(null);

  useEffect(() => {
    if (prevCode.current === code) return;
    prevCode.current = code;
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
        <pre className="mt-1 overflow-x-auto font-mono text-[12px] text-muted">{code}</pre>
      </div>
    );
  }

  if (!svg) {
    return (
      <div className={cn("h-24 animate-pulse rounded-md bg-sunken", className)} />
    );
  }

  return (
    <div
      className={cn("overflow-x-auto", className)}
      // biome-ignore lint/security/noDangerouslySetInnerHtml: mermaid produces sanitized SVG under securityLevel:strict
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
