
// Excalidraw is reached only through this file, which sketch-pad loads lazily on first use, so the
// package stays out of every chunk a screen without a sketch loads.

import "@excalidraw/excalidraw/index.css";
import { Excalidraw, exportToBlob } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { useEffect, useState } from "react";

/** What the pad asks of the canvas: the sketch as a PNG, or null while nothing is drawn. */
export type SketchExport = () => Promise<Blob | null>;

/** `exportToBlob`'s own declaration names types its package does not ship, so it is read through the shape it is called with. */
type ToBlob = (opts: { elements: unknown; appState: unknown; files: unknown; mimeType: string }) => Promise<Blob>;
const toBlob = exportToBlob as unknown as ToBlob;

export default function SketchCanvas({ onReady }: { onReady: (exportPng: SketchExport | null) => void }) {
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);

  useEffect(() => {
    if (!api) return;
    onReady(() => {
      const elements = api.getSceneElements();
      if (elements.length === 0) return Promise.resolve(null);
      return toBlob({
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
