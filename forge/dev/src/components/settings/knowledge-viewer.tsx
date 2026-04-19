import { useState, useRef, useEffect } from "react";
import type { KnowledgeIndex } from "@/lib/types";
import { KnowledgeGraph, type GraphLayout } from "./knowledge-graph";

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-b border-gray-100 last:border-0">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-gray-50"
      >
        <span className="text-xs text-gray-400">{open ? "v" : ">"}</span>
        <span className="font-medium text-gray-800">{label}</span>
      </button>
      {open && <div className="px-6 pb-3 text-xs text-gray-600 space-y-1">{children}</div>}
    </div>
  );
}

function KnowledgeTreeView({ index }: { index: KnowledgeIndex }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white">
      {index.project && (
        <div className="border-b border-gray-200 px-3 py-2">
          <p className="text-sm text-gray-800">{index.project}</p>
        </div>
      )}
      {index.architecture && (
        <div className="border-b border-gray-200 px-3 py-2">
          <p className="text-xs text-gray-500">{index.architecture}</p>
        </div>
      )}
      {index.conventions && Object.keys(index.conventions).length > 0 && (
        <Section label="Conventions">
          {Object.entries(index.conventions).map(([k, v]) => (
            <p key={k}><span className="font-medium">{k}:</span> {v}</p>
          ))}
        </Section>
      )}
      {index.recipes && Object.keys(index.recipes).length > 0 && (
        <Section label="Recipes">
          {Object.entries(index.recipes).map(([k, v]) => (
            <p key={k}><span className="font-medium">{k}:</span> {v}</p>
          ))}
        </Section>
      )}
      {index.paths && Object.keys(index.paths).length > 0 && (
        <Section label="Path Templates">
          {Object.entries(index.paths).map(([k, v]) => (
            <p key={k}><span className="font-medium">{k}:</span> <code className="bg-gray-100 px-1 rounded">{v}</code></p>
          ))}
        </Section>
      )}
      {index.domains && Object.keys(index.domains).length > 0 && (
        <Section label="Domains">
          {Object.entries(index.domains).map(([k, resources]) => (
            <div key={k}>
              <span className="font-medium">{k}:</span>
              <span className="ml-1 text-gray-500">{resources.join(", ")}</span>
            </div>
          ))}
        </Section>
      )}
      {index.commands && Object.keys(index.commands).length > 0 && (
        <Section label="Commands">
          {Object.entries(index.commands).map(([k, v]) => (
            <p key={k}><code className="bg-gray-100 px-1 rounded">{k}</code>: {v}</p>
          ))}
        </Section>
      )}
    </div>
  );
}

type ViewMode = "list" | "force" | "radial" | "mindmap";

const VIEW_OPTIONS: { value: ViewMode; label: string }[] = [
  { value: "force", label: "Force" },
  { value: "radial", label: "Radial" },
  { value: "mindmap", label: "Mind Map" },
  { value: "list", label: "List" },
];

export function KnowledgeViewer({ knowledgeIndex }: { knowledgeIndex: Record<string, KnowledgeIndex> }) {
  const [view, setView] = useState<ViewMode>("force");
  const containerRef = useRef<HTMLDivElement>(null);
  const [dims, setDims] = useState({ w: 600, h: 500 });

  useEffect(() => {
    if (!containerRef.current) return;
    const ro = new ResizeObserver(([entry]) => {
      const w = Math.floor(entry.contentRect.width);
      const rect = containerRef.current?.getBoundingClientRect();
      const maxH = rect ? Math.floor(window.innerHeight - rect.top - 32) : 600;
      if (w > 0) setDims({ w, h: Math.min(Math.max(400, Math.floor(w * 0.6)), maxH) });
    });
    ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, []);

  if (!knowledgeIndex || Object.keys(knowledgeIndex).length === 0) return null;

  const graphLayout: GraphLayout | null = view === "list" ? null : view;

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-gray-700">Knowledge Index</h2>
        <div className="flex gap-1 rounded-md border border-gray-200 p-0.5">
          {VIEW_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              onClick={() => setView(opt.value)}
              className={`rounded px-2.5 py-1 text-xs ${view === opt.value ? "bg-gray-800 text-white" : "text-gray-500 hover:text-gray-700"}`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>
      <div ref={containerRef} className="space-y-4">
        {Object.entries(knowledgeIndex).map(([repoName, index]) => (
          <div key={repoName}>
            <p className="mb-1 text-xs font-medium text-gray-500">{repoName}</p>
            {graphLayout && index.domains ? (
              <KnowledgeGraph index={index} width={dims.w} height={dims.h} layout={graphLayout} />
            ) : (
              <KnowledgeTreeView index={index} />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
