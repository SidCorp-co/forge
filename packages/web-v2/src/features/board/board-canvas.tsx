
// Excalidraw is reached only through this file, which features/board/lazy.tsx loads on first use,
// so the package stays out of every chunk a screen without a board loads.

import "@excalidraw/excalidraw/index.css";
import {
  CaptureUpdateAction,
  convertToExcalidrawElements,
  Excalidraw,
  exportToSvg,
  restoreElements,
} from "@excalidraw/excalidraw";
import type { ExcalidrawElementSkeleton } from "@excalidraw/excalidraw/data/transform";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { WireframeArrowEnd, WireframeDoc, WireframeShape } from "@forge/contracts/wireframe";
import { useEffect, useRef, useState } from "react";
import { boardExporter, useBoard } from "./board-store";

// `exportToSvg` is re-exported from @excalidraw/utils, which the package's types name but do not ship,
// so its signature is written out here as the docs give it.
const toSvg = exportToSvg as unknown as (opts: {
  elements: ReturnType<ExcalidrawImperativeAPI["getSceneElements"]>;
  appState: ReturnType<ExcalidrawImperativeAPI["getAppState"]> & { exportBackground: boolean };
  files: ReturnType<ExcalidrawImperativeAPI["getFiles"]>;
}) => Promise<SVGSVGElement>;

/** The text a box shows inside it. */
function boxText(s: WireframeShape): string {
  switch (s.type) {
    case "list":
      return [s.label, ...s.items].filter(Boolean).join("\n");
    case "input":
      return s.label ?? s.placeholder ?? "";
    case "image":
      return `[image] ${s.label ?? ""}`.trim();
    case "frame":
    case "button":
      return s.label ?? "";
    default:
      return "";
  }
}

function centre(doc: WireframeDoc, end: WireframeArrowEnd): { x: number; y: number } {
  if (!("id" in end)) return end;
  const s = doc.shapes.find((x) => x.id === end.id);
  if (!s || s.type === "arrow" || s.type === "pen") return { x: 0, y: 0 };
  return { x: s.x + s.w / 2, y: s.y + s.h / 2 };
}

/** What a box keeps beyond its place and size, under `wf` its wireframe type. */
function boxData(s: WireframeShape): Record<string, unknown> {
  const rest: Record<string, unknown> = { ...s };
  for (const k of ["id", "type", "x", "y", "w", "h"]) delete rest[k];
  return { wf: s.type, ...rest };
}

type Arrow = Extract<WireframeShape, { type: "arrow" }>;
type Pen = Extract<WireframeShape, { type: "pen" }>;
type Box = Exclude<WireframeShape, { type: "arrow" | "pen" | "text" }>;

function arrowSkeleton(doc: WireframeDoc, s: Arrow): ExcalidrawElementSkeleton {
  const a = centre(doc, s.from);
  const b = centre(doc, s.to);
  return {
    type: "arrow",
    id: s.id,
    x: a.x,
    y: a.y,
    width: b.x - a.x,
    height: b.y - a.y,
    points: [
      [0, 0],
      [b.x - a.x, b.y - a.y],
    ] as never,
    ...("id" in s.from ? { start: { id: s.from.id } } : {}),
    ...("id" in s.to ? { end: { id: s.to.id } } : {}),
    ...(s.label ? { label: { text: s.label } } : {}),
  };
}

/** A pen stroke as a freedraw element, in Excalidraw's default stroke colour. */
function penElement(s: Pen): Record<string, unknown> {
  const xs = s.points.map((p) => p[0]);
  const ys = s.points.map((p) => p[1]);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return {
    type: "freedraw",
    id: s.id,
    x,
    y,
    width: Math.max(...xs) - x,
    height: Math.max(...ys) - y,
    points: s.points.map(([px, py]) => [px - x, py - y]),
    pressures: [],
    simulatePressure: true,
  };
}

function boxSkeleton(s: Box): ExcalidrawElementSkeleton {
  const text = boxText(s);
  return {
    type: "rectangle",
    id: s.id,
    x: s.x,
    y: s.y,
    width: s.w,
    height: s.h,
    customData: boxData(s),
    // flat like the page: no fills; a frame is dashed, an image dotted, a button rounded and heavier
    strokeStyle: s.type === "frame" ? "dashed" : s.type === "image" ? "dotted" : "solid",
    ...(s.type === "button" ? { roundness: { type: 3 }, strokeWidth: 2 } : {}),
    ...(text ? { label: { text, fontSize: 16, verticalAlign: s.type === "frame" || s.type === "list" ? "top" : "middle" } } : {}),
  };
}

/** wireframe-v1 as Excalidraw elements, each under its shape's id; button, input and list are labelled rectangles. `scene-to-wireframe.ts` reads them back. */
export function toScene(doc: WireframeDoc) {
  const skeletons: ExcalidrawElementSkeleton[] = [];
  const pens: Record<string, unknown>[] = [];
  for (const s of doc.shapes) {
    if (s.type === "text") skeletons.push({ type: "text", id: s.id, x: s.x, y: s.y, text: s.text, fontSize: 16 });
    else if (s.type === "arrow") skeletons.push(arrowSkeleton(doc, s));
    else if (s.type === "pen") pens.push(penElement(s));
    else skeletons.push(boxSkeleton(s));
  }
  return [
    ...convertToExcalidrawElements(skeletons, { regenerateIds: false }),
    ...restoreElements(pens as never, null),
  ];
}

/**
 * The read-only board: the chat dock's own (the store's document), or a given one, as a mockup page
 * shows a stored board. `fit` zooms a given board out until all of it shows, once its scene has
 * loaded, for a page that shows it as a picture nobody pans (zoom is capped at 100%).
 */
export default function BoardCanvas({ doc: given, fit = false }: { doc?: WireframeDoc; fit?: boolean } = {}) {
  const board = useBoard();
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);
  const shownRef = useRef<unknown>(null);
  const doc = board.doc;
  const version = board.loaded;

  // a given board is complete at mount, so it goes in as initialData; a scene pushed through the
  // API before Excalidraw's first load is replaced by its empty initial scene, and the board shows blank
  useEffect(() => {
    if (given || !api || shownRef.current === version || !doc) return;
    shownRef.current = version;
    api.updateScene({ elements: toScene(doc), captureUpdate: CaptureUpdateAction.IMMEDIATELY });
    api.scrollToContent(undefined, { fitToContent: true });
  }, [api, version, doc, given]);

  useEffect(() => {
    if (!api || !given || !fit) return;
    const stop = api.onChange((elements) => {
      if (elements.length === 0) return;
      stop();
      api.scrollToContent(undefined, { fitToContent: true });
    });
    return stop;
  }, [api, given, fit]);

  useEffect(() => {
    if (!api || given) return;
    boardExporter.set(async () => {
      const svg = await toSvg({
        elements: api.getSceneElements(),
        appState: { ...api.getAppState(), exportBackground: true },
        files: api.getFiles(),
      });
      return svg.outerHTML;
    });
    return () => boardExporter.set(null);
  }, [api, given]);

  return (
    <div className="h-full w-full" data-testid="board-canvas">
      <Excalidraw
        excalidrawAPI={setApi}
        initialData={given ? { elements: toScene(given), scrollToContent: true } : null}
        viewModeEnabled
        UIOptions={{ tools: { image: false } }}
      />
    </div>
  );
}
