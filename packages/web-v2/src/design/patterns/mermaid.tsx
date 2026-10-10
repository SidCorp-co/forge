
import { useQuery } from "@tanstack/react-query";
import { useId } from "react";
import { useCopy } from "@/lib/i18n/interface-language";
import { cn } from "@/lib/utils/cn";

interface MermaidDiagramProps {
  code: string;
  className?: string;
}

let mermaidReady = false;

async function loadMermaid() {
  const m = await import("mermaid");
  if (!mermaidReady) {
    m.default.initialize({ startOnLoad: false, securityLevel: "strict", theme: "neutral" });
    mermaidReady = true;
  }
  return m.default;
}

/** Renders `code` to an SVG element. Mermaid's strict security level sanitizes what it draws. */
async function renderSvg(id: string, code: string): Promise<SVGElement> {
  const mermaid = await loadMermaid();
  await mermaid.parse(code);
  const { svg } = await mermaid.render(id, code);
  const root = new DOMParser().parseFromString(svg, "image/svg+xml").documentElement;
  if (!(root instanceof SVGElement)) throw new Error("mermaid returned no SVG");
  return root;
}

/** Client-only Mermaid diagram renderer. Never enters the SSR bundle (dynamic import). */
export function MermaidDiagram({ code, className }: MermaidDiagramProps) {
  const id = `mermaid-${useId().replace(/:/g, "")}`;
  const diagram = useQuery({ queryKey: ["mermaid", id, code], queryFn: () => renderSvg(id, code), staleTime: Infinity, retry: false });
  const t = useCopy();

  if (diagram.isError) {
    return (
      <div className={cn("border-l-2 border-danger-9 bg-sunken px-3 py-2", className)}>
        <p className="fg-caption font-mono text-danger-11">{t("common.mermaid.parseError", { error: diagram.error.message })}</p>
        <pre className="mt-1 overflow-x-auto font-mono text-12 text-muted">{code}</pre>
      </div>
    );
  }
  if (!diagram.data) return <div className={cn("h-24 animate-pulse bg-sunken", className)} />;
  const svg = diagram.data;
  return (
    <div
      className={cn("overflow-x-auto", className)}
      ref={(node) => {
        node?.replaceChildren(svg.cloneNode(true));
      }}
    />
  );
}
