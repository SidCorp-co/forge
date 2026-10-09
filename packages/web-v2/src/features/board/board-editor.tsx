"use client";

// The board a person draws a requirement's wireframe on (REQ-35, ISS-460): the same Excalidraw
// canvas `board-canvas.tsx` shows read-only, open for drawing. It opens on the wireframe it is given
// and hands each change of the scene to its page, which reads it back with `sceneToWireframe`.
//
// It offers only the tools whose shapes a wireframe keeps. The `<Excalidraw>` wrapper passes on
// `UIOptions.tools.image` alone, so the other tools cannot be switched off there: `board-editor.css`
// hides their toolbar buttons and the extra-tools menu (frame, embed, diagram), and a tool reached
// another way (a shortcut, the command palette) is put back to the selection the moment it is
// taken. An element that still arrives, pasted or from a library, is refused by name on save.
// Like the read-only board it is reached only through next/dynamic with ssr:false.

import "@excalidraw/excalidraw/index.css";
import "./board-editor.css";
import { Excalidraw } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { WireframeDoc } from "@forge/contracts/wireframe";
import { useRef } from "react";
import { toScene } from "./board-canvas";
import type { SceneElement } from "./scene-to-wireframe";

/** Tools whose elements no wireframe shape holds; `board-editor.css` hides the same set. */
export const NOT_KEPT_TOOLS: ReadonlySet<string> = new Set(["ellipse", "diamond", "line", "image", "frame", "magicframe", "embeddable"]);

export default function BoardEditor({ doc, onScene }: { doc: WireframeDoc | null; onScene: (elements: readonly SceneElement[]) => void }) {
  const api = useRef<ExcalidrawImperativeAPI | null>(null);
  return (
    <div className="wf-board-editor h-full w-full" data-testid="board-editor">
      <Excalidraw
        excalidrawAPI={(a) => {
          api.current = a;
        }}
        initialData={doc ? { elements: toScene(doc), scrollToContent: true } : null}
        onChange={(elements, appState) => {
          if (NOT_KEPT_TOOLS.has(appState.activeTool.type)) api.current?.setActiveTool({ type: "selection" });
          onScene(elements as unknown as readonly SceneElement[]);
        }}
        UIOptions={{ tools: { image: false } }}
      />
    </div>
  );
}
