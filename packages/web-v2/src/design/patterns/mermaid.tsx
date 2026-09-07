"use client";

import { useEffect, useId, useState } from "react";
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
  // cm:guard strip the colons `useId` emits — mermaid uses this string as an element id and a colon makes its own querySelector throw, so the diagram fails on a value React is free to produce.
  const id = `mermaid-${rawId.replace(/:/g, "")}`;
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // cm:guard no "same code, already done" ref guard here. React's dev double-invoke runs the effect, cancels it, and runs it again — a ref set on the first pass makes the second return early, so the cancelled render is the only one that ever happened and the skeleton never resolves. `[code, id]` already prevents the redundant work this was reaching for.
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
