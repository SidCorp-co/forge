"use client";

// The board a person draws a requirement's wireframe on (REQ-35, ISS-460): the same Excalidraw
// canvas `board-canvas.tsx` shows read-only, open for drawing. It opens on the wireframe it is given
// and hands each change of the scene to its page, which reads it back with `sceneToWireframe`. Like
// the read-only board it is reached only through next/dynamic with ssr:false.

import "@excalidraw/excalidraw/index.css";
import { Excalidraw } from "@excalidraw/excalidraw";
import type { WireframeDoc } from "@forge/contracts/wireframe";
import { toScene } from "./board-canvas";
import type { SceneElement } from "./scene-to-wireframe";

export default function BoardEditor({ doc, onScene }: { doc: WireframeDoc | null; onScene: (elements: readonly SceneElement[]) => void }) {
  return (
    <div className="h-full w-full" data-testid="board-editor">
      <Excalidraw
        initialData={doc ? { elements: toScene(doc), scrollToContent: true } : null}
        onChange={(elements) => onScene(elements as unknown as readonly SceneElement[])}
        UIOptions={{ tools: { image: false } }}
      />
    </div>
  );
}
