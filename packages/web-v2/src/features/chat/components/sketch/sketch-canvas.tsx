"use client";

// Excalidraw is reached only through this file, which sketch-pad loads with next/dynamic and ssr:false —
// the package touches window at import, so a static import on a server-rendered path breaks the build.

import "@excalidraw/excalidraw/index.css";
import { Excalidraw, exportToBlob } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { useEffect, useState } from "react";

/** What the pad asks of the canvas: the sketch as a PNG, or null while nothing is drawn. */
export type SketchExport = () => Promise<Blob | null>;

export default function SketchCanvas({ onReady }: { onReady: (exportPng: SketchExport | null) => void }) {
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);

  useEffect(() => {
    if (!api) return;
    onReady(async () => {
      const elements = api.getSceneElements();
      if (elements.length === 0) return null;
      return exportToBlob({
        elements,
        appState: { ...api.getAppState(), exportBackground: true },
        files: api.getFiles(),
        mimeType: "image/png",
      });
    });
    return () => onReady(null);
  }, [api, onReady]);

  return (
    <div className="h-full w-full" data-testid="sketch-canvas">
      <Excalidraw
        excalidrawAPI={setApi}
        initialData={{ appState: { activeTool: { type: "freedraw" } as never } }}
        UIOptions={{ tools: { image: false } }}
      />
    </div>
  );
}
